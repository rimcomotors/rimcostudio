import { describe, expect, it } from 'vitest';
import { limitRelationToLatest } from './library-query';

class FakeQuery {
  calls: Array<{ method: string; column?: string; value?: number; options: Record<string, unknown> }> = [];

  order(column: string, options: { ascending?: boolean; referencedTable?: string }) {
    this.calls.push({ method: 'order', column, options });
    return this;
  }

  limit(value: number, options: { referencedTable?: string }) {
    this.calls.push({ method: 'limit', value, options });
    return this;
  }
}

describe('limitRelationToLatest', () => {
  it('orders the related versions newest first and fetches only one', () => {
    const query = new FakeQuery();

    expect(limitRelationToLatest(query, 'video_versions', 'number')).toBe(query);
    expect(query.calls).toEqual([
      { method: 'order', column: 'number', options: { referencedTable: 'video_versions', ascending: false } },
      { method: 'limit', value: 1, options: { referencedTable: 'video_versions' } },
    ]);
  });
});
