import ExternalAPI from '@server/api/externalapi';
import cacheManager from '@server/lib/cache';
import jaro from 'wink-jaro-distance';

interface DoubanSuggestResult {
  id: string;
  title: string;
  sub_title?: string;
  type?: string;
  year?: string;
  url?: string;
}

interface DoubanSearchResponse {
  subjects?: DoubanSearchResult[];
}

interface DoubanSearchResult {
  id: string;
  title: string;
  rate?: string;
  url?: string;
}

interface DoubanAbstractResponse {
  r?: number;
  subject?: {
    id?: string;
    title?: string;
    type?: string;
    url?: string;
    rate?: string;
    rating?: {
      value?: number | string;
      count?: number;
    };
    release_year?: string;
  };
}

export interface DoubanRating {
  title: string;
  url: string;
  userScore: number;
  userScoreCount?: number;
}

interface DoubanMovieSearchOptions {
  title: string;
  originalTitle?: string;
  year?: number;
  imdbId?: string;
}

const MINIMUM_SCORE = 0.45;
const norm = (value: string): string =>
  value.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');

const similarity = (a: string, b: string): number => {
  const normalizedA = norm(a);
  const normalizedB = norm(b);

  if (!normalizedA || !normalizedB) {
    return 0;
  }

  if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) {
    return 1;
  }

  return jaro(normalizedA, normalizedB).similarity;
};

const titleScore = (result: DoubanSuggestResult, titles: string[]): number => {
  const resultTitles = [result.title, result.sub_title].filter(
    (value): value is string => Boolean(value)
  );

  return Math.max(
    ...resultTitles.flatMap((resultTitle) =>
      titles.map((title) => similarity(resultTitle, title))
    )
  );
};

const yearScore = (result: DoubanSuggestResult, year?: number): number => {
  const resultYear = Number(result.year);

  if (!year || !resultYear) {
    return 1;
  }

  return Math.max(0, 1 - Math.abs(resultYear - year) * 0.4);
};

const best = (
  results: DoubanSuggestResult[],
  titles: string[],
  year?: number
): DoubanSuggestResult | undefined => {
  const movieResults = results.filter(
    (result) => !result.type || result.type === 'movie'
  );
  const scoredResults = movieResults.map((result) => ({
    result,
    score: titleScore(result, titles) * yearScore(result, year),
  }));
  const match = scoredResults
    .filter(({ score }) => score >= MINIMUM_SCORE)
    .sort(({ score: a }, { score: b }) => b - a)[0]?.result;

  if (match) {
    return match;
  }

  if (
    year &&
    movieResults.length === 1 &&
    Number(movieResults[0].year) === year
  ) {
    return movieResults[0];
  }
};

/**
 * This is a best-effort provider using Douban's public movie endpoints.
 * Douban does not provide a stable public API for this use case, so all
 * matching is intentionally conservative.
 */
class Douban extends ExternalAPI {
  constructor() {
    super(
      'https://movie.douban.com',
      {},
      {
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: 'https://movie.douban.com/',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        },
        nodeCache: cacheManager.getCache('douban').data,
        rateLimit: {
          maxRequests: 1,
          maxRPS: 1,
        },
        timeout: 10000,
      }
    );
  }

  public async getMovieRatings({
    title,
    originalTitle,
    year,
  }: DoubanMovieSearchOptions): Promise<DoubanRating | null> {
    const titles = Array.from(
      new Set(
        [title, originalTitle].filter(
          (value): value is string => Boolean(value)
        )
      )
    );

    for (const query of titles) {
      const suggestions = await this.get<DoubanSuggestResult[]>(
        '/j/subject_suggest',
        { params: { q: query } }
      );

      const match = best(suggestions, titles, year);

      if (!match?.id) {
        continue;
      }

      const rating = await this.getSubjectRating(
        match.id,
        undefined,
        match.title,
        match.url
      );

      if (rating) {
        return rating;
      }
    }

    for (const query of titles) {
      const search = await this.get<DoubanSearchResponse>('/j/search_subjects', {
        params: {
          type: 'movie',
          tag: query,
          page_limit: 10,
          page_start: 0,
        },
      });

      for (const result of search.subjects ?? []) {
        const rating = await this.getSubjectRating(
          result.id,
          result.rate,
          result.title,
          result.url
        );

        if (
          rating &&
          (!year || !rating.year || Math.abs(rating.year - year) <= 1)
        ) {
          return rating;
        }
      }
    }

    return null;
  }

  private async getSubjectRating(
    subjectId: string,
    fallbackRate?: string,
    fallbackTitle?: string,
    fallbackUrl?: string
  ): Promise<(DoubanRating & { year?: number }) | null> {
    const abstract = await this.get<DoubanAbstractResponse>(
      '/j/subject_abstract',
      { params: { subject_id: subjectId } }
    );
    const subject = abstract.subject;
    const userScore = Number(
      subject?.rate ?? subject?.rating?.value ?? fallbackRate
    );

    if (
      (abstract.r !== undefined && abstract.r !== 0) ||
      !subject ||
      !userScore
    ) {
      return null;
    }

    return {
      title: subject.title ?? fallbackTitle ?? subjectId,
      url:
        subject.url ??
        fallbackUrl ??
        `https://movie.douban.com/subject/${subjectId}/`,
      userScore,
      userScoreCount: subject.rating?.count,
      year: subject.release_year ? Number(subject.release_year) : undefined,
    };
  }
}

export default Douban;
