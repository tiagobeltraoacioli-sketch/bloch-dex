// Presentation of a failed read: which kind it is, what to call it and what the user can do. The message itself is
// always shown in full next to these words; nothing here decides whether anything is sent (a failed read sends
// nothing, by the route's own logic).

export type ReadFailureKind =
  | 'disagreement'
  | 'unconfirmed'
  | 'rate-limited'
  | 'unreachable'
  | 'other';
export type ReadFailure = {
  kind: ReadFailureKind;
  title: string;
  /** For the whole page: the snapshot could not be read. */
  advice: string;
  /** For one refused read while the page is up (a quote): what the user can do. Nothing reads again by itself there. */
  quoteAdvice: string;
  /** Whether a newer block is likely to help, so the alert offers the page's Refresh. */
  refresh: boolean;
  /** `auto`: the page reads again by itself, backing off; `manual`: only when the user asks. */
  retry: 'auto' | 'manual';
};

/** Seconds before each automatic new read; the last value repeats. */
export const READ_RETRY_SECONDS = [15, 30, 60, 120] as const;
export const readRetrySeconds = (attempt: number): number =>
  READ_RETRY_SECONDS[Math.min(Math.max(0, attempt), READ_RETRY_SECONDS.length - 1)];

/**
 * The texts matched are the ones the page itself writes: `DISAGREEMENT` and `UNCONFIRMED` of multichain/rpc.ts
 * (asserted against those constants in the tests), and the HTTP status or the JSON-RPC text of an endpoint that
 * limits requests.
 */
export function classifyReadFailure(message: string): ReadFailure {
  if (/the two RPC endpoints of this network disagree about the chain/.test(message))
    return {
      kind: 'disagreement',
      title: 'The endpoints disagree',
      advice:
        'Two independent endpoints gave different answers for the same block, so at least one of them is wrong. This page does not choose between them and reads again only when you ask. If this stays, do not trade here until it clears.',
      quoteAdvice:
        'Two independent endpoints gave different answers for the same block, so at least one of them is wrong. Nothing was sent. Refresh reads the chain again; if this stays, do not trade here until it clears.',
      refresh: true,
      retry: 'manual',
    };
  if (/a second RPC endpoint could not confirm this read/.test(message))
    return {
      kind: 'unconfirmed',
      title: 'A second endpoint has not confirmed',
      advice:
        'Every figure on this page must be the same on two endpoints. One of them did not answer, so the page waits and reads again by itself, a little later each time.',
      quoteAdvice:
        'This read must be the same on two endpoints, and one of them did not answer for the block this page is reading from: it is busy, or that block is already too old for it. Nothing was sent. Refresh reads a newer block; then get the quote again.',
      refresh: true,
      retry: 'auto',
    };
  if (
    /HTTP 429|too many requests|rate.?limit|request limit|limit exceeded|quota|throttl/i.test(
      message,
    )
  )
    return {
      kind: 'rate-limited',
      title: 'The endpoint is limiting requests',
      advice:
        'The public endpoints of this network are shared and refuse requests for a while when they are busy. The page backs off and reads again by itself; your funds and any transaction you already sent are not affected.',
      quoteAdvice:
        'The public endpoints of this network are shared and refuse requests for a while when they are busy. Nothing was sent. Wait a moment and get the quote again.',
      refresh: false,
      retry: 'auto',
    };
  // What a browser reports when a request got no usable answer: the network is down, the endpoint timed out, or
  // (common on shared public endpoints) it refused the request without the headers a browser needs to read why.
  if (
    /Failed to fetch|NetworkError|Load failed|network request failed|timed out|TimeoutError|aborted/i.test(
      message,
    )
  )
    return {
      kind: 'unreachable',
      title: 'The endpoint did not answer',
      advice:
        'No endpoint of this network gave an answer the browser could read: the connection is down, or a busy public endpoint refused the request. The page reads again by itself, a little later each time.',
      quoteAdvice:
        'No endpoint of this network gave an answer the browser could read. Nothing was sent. Check the connection, wait a moment and get the quote again.',
      refresh: false,
      retry: 'auto',
    };
  return {
    kind: 'other',
    title: 'Reads unavailable',
    advice: '',
    quoteAdvice: '',
    refresh: false,
    retry: 'manual',
  };
}

/** m:ss, or h:mm:ss from one hour. */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}
