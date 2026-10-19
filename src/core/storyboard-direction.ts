import { z } from 'zod';

export const MAX_STORYBOARD_DIRECTION_LENGTH = 1000;

export const storyboardDirectionSchema = z.string().trim().max(MAX_STORYBOARD_DIRECTION_LENGTH);
