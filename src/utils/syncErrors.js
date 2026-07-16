/**
 * The sync modules all throw the project's snake_case error codes; i18n uses camelCase
 * keys. One table, because four settings pages need the same mapping and a fifth would
 * have copied it slightly wrong.
 */
export const SYNC_ERROR_KEYS = {
  not_configured: 'notConfigured',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  not_found: 'notFound',
  conflict: 'conflict',
  rate_limited: 'rateLimited',
  server_error: 'serverError',
  network_error: 'networkError',
  invalid_payload: 'invalidPayload',
  request_failed: 'requestFailed',
  aborted: 'aborted',
}
