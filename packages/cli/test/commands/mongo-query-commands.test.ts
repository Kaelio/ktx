import { InvalidArgumentError } from '@commander-js/extra-typings';
import { describe, expect, it } from 'vitest';
import { parseLimitOption, parsePipelineArgument } from '../../src/commands/mongo-query-commands.js';

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

describe('parseLimitOption', () => {
  it('accepts the boundary values 1 and 10000', () => {
    expect(parseLimitOption('1')).toBe(1);
    expect(parseLimitOption('10000')).toBe(10000);
  });

  it('rejects a non-numeric value', () => {
    expect(() => parseLimitOption('abc')).toThrow(InvalidArgumentError);
  });

  it('rejects a non-integer value', () => {
    expect(() => parseLimitOption('1.5')).toThrow(InvalidArgumentError);
  });

  it('rejects a value below 1', () => {
    expect(() => parseLimitOption('0')).toThrow(InvalidArgumentError);
  });

  it('rejects a value above the cap', () => {
    expect(() => parseLimitOption('10001')).toThrow(InvalidArgumentError);
  });
});
