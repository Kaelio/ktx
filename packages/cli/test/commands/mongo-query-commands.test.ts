import { InvalidArgumentError } from '@commander-js/extra-typings';
import { describe, expect, it } from 'vitest';
import { parsePipelineArgument } from '../../src/commands/mongo-query-commands.js';

describe('parsePipelineArgument', () => {
  it('parses a valid JSON array of pipeline-stage objects', () => {
    expect(parsePipelineArgument('[{"$match":{"city":"NY"}},{"$limit":10}]')).toEqual([
      { $match: { city: 'NY' } },
      { $limit: 10 },
    ]);
  });

  it('parses an empty pipeline array', () => {
    expect(parsePipelineArgument('[]')).toEqual([]);
  });

  it('throws InvalidArgumentError on invalid JSON', () => {
    expect(() => parsePipelineArgument('{not json')).toThrow(InvalidArgumentError);
  });

  it('throws InvalidArgumentError when the value is not an array', () => {
    expect(() => parsePipelineArgument('{}')).toThrow(InvalidArgumentError);
  });

  it('throws InvalidArgumentError when the array contains a non-object stage', () => {
    expect(() => parsePipelineArgument('[{"$match":{}}, "not-a-stage"]')).toThrow(InvalidArgumentError);
  });

  it('throws InvalidArgumentError when the array contains a nested array stage', () => {
    expect(() => parsePipelineArgument('[[1,2,3]]')).toThrow(InvalidArgumentError);
  });

  it('throws InvalidArgumentError when the array contains null', () => {
    expect(() => parsePipelineArgument('[null]')).toThrow(InvalidArgumentError);
  });
});
