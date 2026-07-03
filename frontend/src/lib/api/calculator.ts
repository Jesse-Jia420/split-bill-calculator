/**
 * v0.2.1 T01 — Mirror of the backend `AmountCalculator.evaluate()`.
 *
 * The frontend evaluator lives in the browser so the right-side
 * preview can update without round-tripping the API. The logic MUST
 * stay byte-identical to `backend/app/services/calculator.py`:
 * the BE applies the same function as the final source of truth
 * (so a malicious FE cannot smuggle past the whitelist by sending
 * raw amount + valid expression only — the BE evaluates the
 * expression and rejects).
 *
 * Whitelist: digits + - * / . and whitespace (PRD §3.6.1).
 * No parentheses, no exponentiation, no unary sign except
 * leading minus or after another operator.
 *
 * Returns ``null`` on any parse / structural / divide-by-zero error
 * to make caller code (`AmountCalculatorInput`) ergonomic.
 */
const WHITESPACE_RE = /\s+/g;
const REJECTED_RE = /[^0-9+\-*/.\s]/;

const BINARY_OPS = new Set(['+', '-', '*', '/']);
const DISPLAY_QUANTUM = 0.01;

/**
 * Evaluate an arithmetic expression and return the value rounded to
 * 2 decimal places (HALF_UP). Returns ``null`` on any error.
 */
export function evaluateExpression(expr: string | null | undefined): number | null {
  if (expr == null) return null;
  const cleaned = (WHITESPACE_RE as any).test(expr) ? expr.replace(WHITESPACE_RE, '') : expr.replace(/\s+/g, '');
  if (!cleaned) return null;
  if (REJECTED_RE.test(cleaned)) return null;

  try {
    _checkOperatorOrder(cleaned);
  } catch {
    return null;
  }

  try {
    return _evaluateClean(cleaned);
  } catch {
    return null;
  }
}

/** Boolean wrapper useful for form-level validation. */
export function isValidExpression(expr: string | null | undefined): boolean {
  return evaluateExpression(expr) !== null;
}

function _checkOperatorOrder(cleaned: string): void {
  if (BINARY_OPS.has(cleaned[0])) {
    throw new Error('starts with operator');
  }
  if (BINARY_OPS.has(cleaned[cleaned.length - 1])) {
    throw new Error('ends with operator');
  }
  for (let i = 0; i < cleaned.length; i++) {
    const prev = i > 0 ? cleaned[i - 1] : '';
    const ch = cleaned[i];
    if (BINARY_OPS.has(ch) && BINARY_OPS.has(prev)) {
      throw new Error('two operators');
    }
    if (ch === '.' && prev === '.') {
      throw new Error('two dots');
    }
  }
}

function _evaluateClean(cleaned: string): number {
  // Tokenise into numbers + operators.
  const tokens: string[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const ch = cleaned[i];
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < cleaned.length && /[0-9.]/.test(cleaned[j])) j++;
      tokens.push(cleaned.slice(i, j));
      i = j;
    } else {
      tokens.push(ch);
      i++;
    }
  }
  if (tokens.length === 0) throw new Error('empty');

  // Walk +/- precedence and *// within each term.
  let total = 0;
  let sign = 1;
  let acc: number | null = null;

  // First token must be a number.
  acc = Number(tokens[0]);
  if (!Number.isFinite(acc)) throw new Error('bad num');
  let idx = 1;

  while (idx < tokens.length) {
    const tok = tokens[idx++];
    if (tok === '+' || tok === '-') {
      total += sign * (acc ?? 0);
      sign = tok === '+' ? 1 : -1;
      acc = null;
      if (idx >= tokens.length) throw new Error('trailing op');
      const n = Number(tokens[idx++]);
      if (!Number.isFinite(n)) throw new Error('bad num');
      acc = n;
    } else if (tok === '*' || tok === '/') {
      if (acc == null) throw new Error('no left');
      if (idx >= tokens.length) throw new Error('trailing op');
      const rhs = Number(tokens[idx++]);
      if (!Number.isFinite(rhs)) throw new Error('bad num');
      if (tok === '*') {
        acc = acc * rhs;
      } else {
        if (rhs === 0) throw new Error('div/0');
        acc = acc / rhs;
      }
    } else {
      throw new Error('bad token');
    }
  }
  total += sign * (acc ?? 0);

  // Quantise to cents (round-half-up, matching BE).
  return Math.round(total * 100 + 1e-9) / 100;
}
