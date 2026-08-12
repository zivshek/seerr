import { type DoubanRating } from '@server/api/rating/douban';
import { type IMDBRating } from '@server/api/rating/imdbRadarrProxy';
import { type RTRating } from '@server/api/rating/rottentomatoes';

export interface RatingResponse {
  rt?: RTRating;
  imdb?: IMDBRating;
  douban?: DoubanRating;
}
