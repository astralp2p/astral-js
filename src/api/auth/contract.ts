// api/auth/contract — the JSON value of a mod.auth.contract and the one line a
// text signer signs for it (astral-go `api/auth/contract.go`).

import type { Identity } from '../../astral/identity.js';
import { ANYONE_KEY, isAnyone, parseIdentity } from '../../astral/identity.js';
import type { ObjectID } from '../../astral/objectid.js';
import type { PermitValue } from './types.js';

/** Wire type tag of an unsigned contract. */
export const CONTRACT_TYPE = 'mod.auth.contract';

/**
 * The JSON value of a `mod.auth.contract`: a flat object keyed by the Go field
 * names (astral-go `api/auth/contract.go`).
 */
export interface ContractValue {
  /** Who grants. `null` is an absent identity, which the signable text shows as 66 zeros. */
  Issuer: Identity | null;
  /** Who is granted. `null` is an absent identity, which the signable text shows as 66 zeros. */
  Subject: Identity | null;
  /** The permits granted; an element is `null` where the wire carried a nil permit. */
  Permits: (PermitValue | null)[] | null;
  /** When the grant lapses: an RFC 3339 UTC string, as astral-go marshals a time. */
  ExpiresAt: string;
  /**
   * The request this contract answers: the entry ID of the stored signed
   * request (`data1…`), not the ID of the request body. An offer (a contract
   * only its issuer signed) and the contract its subject completes from it
   * carry the same `RequestID`. `null` when the contract answers no stored
   * request.
   *
   * The link never adds or redirects authority: a contract has authority only
   * when both its issuer and its subject signed it. The signable text does not
   * show it; the commitment a signer prefixes binds it.
   */
  RequestID: ObjectID | null;
}

/** What {@link contractSignableText} reads of a contract: everything but `RequestID`. */
export type ContractTextInput = Pick<ContractValue, 'Issuer' | 'Subject' | 'ExpiresAt'> & {
  Permits?: ContractValue['Permits'] | undefined;
};

/**
 * The longest signable text of a contract: a text signer such as a Coldcard
 * signs at most 240 bytes, and the commitment prefix `[<20 base64 characters>] `
 * takes 23 of them (astral-go `MaxContractTextLen`).
 */
export const MAX_CONTRACT_TEXT_LEN = 240 - 23;

/** The longest permit word the signable text carries: `len('privileged_member')`. */
export const MAX_PERMIT_WORD_LEN = 17;

/**
 * The action types whose permit names itself by a word in the signable text,
 * the tier of a membership (astral-go `api/user/membership.go`, the types that
 * implement `PermitWorder`). Any other action is named by its type.
 */
const PERMIT_WORDS: Readonly<Record<string, string>> = {
  'mod.user.member_action': 'member',
  'mod.user.trusted_action': 'trusted',
  'mod.user.privileged_member_action': 'privileged_member',
};

const ACTION_PART_RE = /^[a-z0-9_]+$/;

/**
 * How the signable text names `action`: its permit word, else
 * `<module>.<name>` for an action type `mod.<module>.<name>_action` whose parts
 * are in `[a-z0-9_]`. `null` for any other action, which the text counts but
 * does not name (astral-go `actionWord`).
 */
function actionWord(action: string): string | null {
  if (Object.hasOwn(PERMIT_WORDS, action)) return PERMIT_WORDS[action] ?? null;
  if (!action.startsWith('mod.') || !action.endsWith('_action')) return null;
  const rest = action.slice('mod.'.length, action.length - '_action'.length);
  const dot = rest.indexOf('.');
  if (dot < 0) return null;
  const module = rest.slice(0, dot);
  const name = rest.slice(dot + 1);
  return ACTION_PART_RE.test(module) && ACTION_PART_RE.test(name) ? `${module}.${name}` : null;
}

/** An identity as the signable text shows it: 66 zeros for an absent or anonymous one. */
function identityText(id: Identity | null | undefined, field: string): string {
  if (id === null || id === undefined || isAnyone(id)) return ANYONE_KEY;
  if (typeof id !== 'string') throw new TypeError(`contract ${field} is not an identity string`);
  return parseIdentity(id);
}

const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

/**
 * An RFC 3339 UTC time as `YYYY-MM-DD hh:mm:ss`, cut to the second, as Go's
 * `Time.Format("2006-01-02 15:04:05")` renders it.
 */
function timeText(s: unknown): string {
  const m = typeof s === 'string' ? TIME_RE.exec(s) : null;
  if (m === null) {
    throw new TypeError(`contract ExpiresAt is not an RFC 3339 UTC time: ${JSON.stringify(s)}`);
  }
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  // setUTCFullYear keeps years 0-99 as written, which Date.UTC would shift to 19xx.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new TypeError(`contract ExpiresAt is not a valid time: ${JSON.stringify(s)}`);
  }
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

/** The length of the `+<n>` (or `,+<n>`) a list of `shown` words out of `total` actions ends with; 0 when every action is shown. */
function overflowLen(shown: number, total: number): number {
  const left = total - shown;
  if (left === 0) return 0;
  // "+<n>", preceded by a comma when some word is shown.
  return 1 + String(left).length + (shown > 0 ? 1 : 0);
}

/**
 * The longest prefix of `words` that fits in `budget` bytes together with the
 * `+<n>` count of the actions left out.
 */
function actionList(words: string[], hidden: number, budget: number): string {
  const total = words.length + hidden;
  if (total === 0) return 'none';

  let shown = 0;
  let used = 0;
  for (const w of words) {
    const next = used + w.length + (shown > 0 ? 1 : 0); // the comma before w
    if (next + overflowLen(shown + 1, total) > budget) break;
    shown++;
    used = next;
  }

  let list = words.slice(0, shown).join(',');
  const left = total - shown;
  if (left > 0) list += `${shown > 0 ? ',' : ''}+${left}`;
  return list;
}

/**
 * The one line a text signer signs for a contract: astral-go
 * `Contract.SignableText`, byte for byte. A signature is over these bytes, so a
 * difference of one character is a signature that never verifies.
 *
 * ```
 * <issuer> grants <subject> <actions> depth <d> until <YYYY-MM-DD hh:mm:ss>
 * ```
 *
 * `<actions>` lists the distinct permit actions in permit order, comma
 * separated, each by its permit word (`member`, `trusted`, `privileged_member`)
 * or, for a `mod.<module>.<name>_action` type, as `<module>.<name>`. When the
 * line has no room for every action, or an action has no name, the list ends
 * with `+<n>`, the number of actions not shown; a contract without permits shows
 * `none`. `<d>` is the largest `Delegation` among the permits. Constraints are
 * not shown, so the text never shows a grant narrower than the one signed. The
 * time is UTC, cut to the second. The line is printable ASCII of at most
 * {@link MAX_CONTRACT_TEXT_LEN} bytes.
 *
 * `RequestID` is not in the text: the commitment a signer prefixes binds it.
 *
 * @throws {TypeError} On an identity that is not 66-hex or `anyone`, an
 *   `ExpiresAt` that is not an RFC 3339 UTC time, or a permit without a string
 *   `Action` or with a `Delegation` outside 0–255.
 */
export function contractSignableText(c: ContractTextInput): string {
  const head = `${identityText(c.Issuer, 'Issuer')} grants ${identityText(c.Subject, 'Subject')} `;
  const until = timeText(c.ExpiresAt);

  const words: string[] = [];
  const seen = new Set<string>();
  let hidden = 0;
  let depth = 0;
  for (const p of c.Permits ?? []) {
    if (p === null || p === undefined) continue;
    if (typeof p.Action !== 'string') throw new TypeError('contract permit Action is not a string');
    const delegation = p.Delegation ?? 0;
    if (!Number.isInteger(delegation) || delegation < 0 || delegation > 255) {
      throw new TypeError(`permit ${p.Action}: Delegation is not an integer from 0 to 255`);
    }
    depth = Math.max(depth, delegation);
    if (seen.has(p.Action)) continue;
    seen.add(p.Action);
    const w = actionWord(p.Action);
    if (w === null) hidden++;
    else words.push(w);
  }

  const tail = ` depth ${depth} until ${until}`;
  return head + actionList(words, hidden, MAX_CONTRACT_TEXT_LEN - head.length - tail.length) + tail;
}
