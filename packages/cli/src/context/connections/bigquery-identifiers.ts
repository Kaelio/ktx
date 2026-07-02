const BIGQUERY_PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const BIGQUERY_DATASET_ID_PATTERN = /^[A-Za-z0-9_]+$/;
const BIGQUERY_REGION_PATTERN = /^[a-z0-9-]+$/;

export function normalizeBigQueryProjectId(value: string, context = 'historic-SQL ingest'): string {
  if (!BIGQUERY_PROJECT_ID_PATTERN.test(value)) {
    throw new Error(`Invalid BigQuery project id for ${context}: ${value}`);
  }
  return value;
}

export function normalizeBigQueryDatasetId(value: string, context = 'historic-SQL ingest'): string {
  if (!BIGQUERY_DATASET_ID_PATTERN.test(value)) {
    throw new Error(`Invalid BigQuery dataset id for ${context}: ${value}`);
  }
  return value;
}

export function normalizeBigQueryRegion(value: string, context = 'historic-SQL ingest'): string {
  const normalized = value.trim().toLowerCase().replace(/^region-/, '');
  if (!BIGQUERY_REGION_PATTERN.test(normalized)) {
    throw new Error(`Invalid BigQuery region for ${context}: ${value}`);
  }
  return normalized;
}
