import type { Locator, Page } from 'playwright';
import { z } from 'zod';
import type { LocatorSpec, Stability } from './types.js';

export const LocatorSchema = z.discriminatedUnion('by', [
  z.object({ by: z.literal('role'), role: z.string(), name: z.string().optional(), exact: z.boolean().optional() }),
  z.object({ by: z.literal('label'), label: z.string(), exact: z.boolean().optional() }),
  z.object({ by: z.literal('testId'), testId: z.string() }),
  z.object({ by: z.literal('placeholder'), placeholder: z.string() }),
  z.object({ by: z.literal('text'), text: z.string(), exact: z.boolean().optional() }),
  z.object({ by: z.literal('css'), selector: z.string() }),
]);

/** Single-quoted TypeScript string literal. */
export function q(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')}'`;
}

/** Playwright code for a locator, e.g. page.getByRole('button', { name: 'Apply', exact: true }). */
export function locatorCode(spec: LocatorSpec, pageVar = 'page'): string {
  switch (spec.by) {
    case 'role':
      if (spec.name === undefined) return `${pageVar}.getByRole(${q(spec.role)})`;
      return `${pageVar}.getByRole(${q(spec.role)}, { name: ${q(spec.name)}${spec.exact ? ', exact: true' : ''} })`;
    case 'label':
      return `${pageVar}.getByLabel(${q(spec.label)}${spec.exact ? ', { exact: true }' : ''})`;
    case 'testId':
      return `${pageVar}.getByTestId(${q(spec.testId)})`;
    case 'placeholder':
      return `${pageVar}.getByPlaceholder(${q(spec.placeholder)})`;
    case 'text':
      return `${pageVar}.getByText(${q(spec.text)}${spec.exact ? ', { exact: true }' : ''})`;
    case 'css':
      return `${pageVar}.locator(${q(spec.selector)})`;
  }
}

export function resolveLocator(page: Page, spec: LocatorSpec): Locator {
  switch (spec.by) {
    case 'role':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return page.getByRole(spec.role as any, spec.name === undefined ? {} : { name: spec.name, exact: !!spec.exact });
    case 'label':
      return page.getByLabel(spec.label, { exact: !!spec.exact });
    case 'testId':
      return page.getByTestId(spec.testId);
    case 'placeholder':
      return page.getByPlaceholder(spec.placeholder);
    case 'text':
      return page.getByText(spec.text, { exact: !!spec.exact });
    case 'css':
      return page.locator(spec.selector);
  }
}

export function describeLocator(spec: LocatorSpec): string {
  switch (spec.by) {
    case 'role':
      return spec.name ? `${spec.role} "${spec.name}"` : `${spec.role}`;
    case 'label':
      return `field labelled "${spec.label}"`;
    case 'testId':
      return `element with test id "${spec.testId}"`;
    case 'placeholder':
      return `field with placeholder "${spec.placeholder}"`;
    case 'text':
      return `text "${spec.text}"`;
    case 'css':
      return `element matching ${spec.selector}`;
  }
}

export function stabilityOf(spec: LocatorSpec): Stability {
  return spec.by === 'css' || spec.by === 'text' ? 'fragile' : 'stable';
}

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

const LABELLED_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider']);

/**
 * True when a locator written by the AI points at an element recorded in the app map,
 * even if it is phrased differently (getByLabel('Email') vs getByRole('textbox', { name: 'Email' })).
 */
export function matchesElement(el: { role: string; name: string; locator: LocatorSpec }, target: LocatorSpec): boolean {
  if (sameLocator(el.locator, target)) return true;
  if (target.by === 'role') return !!target.name && norm(target.role) === norm(el.role) && norm(target.name) === norm(el.name);
  if (target.by === 'label') return LABELLED_ROLES.has(el.role) && norm(target.label) === norm(el.name);
  return false;
}

/** A locator that names one thing (not just "the alert" or "a textbox"). */
export function isSpecific(target: LocatorSpec): boolean {
  return !(target.by === 'role' && !target.name);
}

/** True when two specs point at the same thing (ignores exact flags and letter case). */
export function sameLocator(a: LocatorSpec, b: LocatorSpec): boolean {
  if (a.by !== b.by) return false;
  switch (a.by) {
    case 'role':
      return norm(a.role) === norm((b as typeof a).role) && norm(a.name) === norm((b as typeof a).name);
    case 'label':
      return norm(a.label) === norm((b as typeof a).label);
    case 'testId':
      return a.testId === (b as typeof a).testId;
    case 'placeholder':
      return norm(a.placeholder) === norm((b as typeof a).placeholder);
    case 'text':
      return norm(a.text) === norm((b as typeof a).text);
    case 'css':
      return a.selector === (b as typeof a).selector;
  }
}
