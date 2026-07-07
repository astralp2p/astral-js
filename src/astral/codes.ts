/**
 * Numeric query/response codes.
 *
 * These are the small integer codes carried by `query_rejected` /
 * `reject_incoming` messages, distinct from the string error codes in
 * {@link module:astral/errors}.
 *
 * @module astral/codes
 */

/** The query succeeded. */
export const CodeSuccess = 0;
/** The query was rejected by the responder. */
export const CodeRejected = 1;
/** The query was malformed. */
export const CodeInvalidQuery = 2;
/** The query was canceled. */
export const CodeCanceled = 3;
/** An internal error occurred. */
export const CodeInternalError = 4;

/** The reject code used when a handler declines a query without a specific code. */
export const DefaultRejectCode = CodeRejected;
