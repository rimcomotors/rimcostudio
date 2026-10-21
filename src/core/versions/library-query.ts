type RelatedQuery<T> = {
  order: (column: string, options: { ascending?: boolean; referencedTable: string }) => T;
  limit: (count: number, options: { referencedTable: string }) => T;
};

/** Keeps library responses to the newest row in a one-to-many relation. */
export function limitRelationToLatest<T extends RelatedQuery<T>>(query: T, relation: string, orderColumn: string): T {
  return query
    .order(orderColumn, { referencedTable: relation, ascending: false })
    .limit(1, { referencedTable: relation });
}
