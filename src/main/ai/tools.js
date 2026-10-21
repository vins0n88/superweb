// Browser tools exposed to the model. Schemas are provider-neutral JSON Schema;
// each provider adapts them. Every tool returns text or throws — a failed
// action is reported as an error, never as a pretend success.

import { normalizeInput } from '../url.js';
import { SUPERAI_TOOL_DEFS } from '../superai-client.js';

const ref = { type: 'integer', description: 'Element ref number from the latest snapshot, e.g. 12 for [12]' };

export const TOOL_DEFS = [
  {
    name: 'propose_plan',
    description: 'Show the user a numbered step plan BEFORE taking any action that clicks, types, or navigates. The user may edit or cancel it. Reading tools do not need a plan.',
    input_schema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'One sentence restating the user\'s goal' },
        steps: { type: 'array', items: { type: 'string' }, description: 'Plain-language steps the user can check, one action each. Name every link, button, or field by its visible text (e.g. Click the link "Aurora X1"); never use [ref] numbers.' },
      },
      required: ['goal', 'steps'],
      additionalProperties: false,
    },
    readOnly: true,
    internal: true,
  },
  {
    name: 'report_result',
    description: 'Report the verified outcome of the task: each requirement from the user\'s request (and approved plan) with status done / partial / not_done and the evidence you checked.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One sentence overall verdict' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              requirement: { type: 'string' },
              status: { type: 'string', enum: ['done', 'partial', 'not_done'] },
              evidence: { type: 'string' },
            },
            required: ['requirement', 'status'],
          },
        },
      },
      required: ['summary', 'items'],
      additionalProperties: false,
    },
    readOnly: true,
    internal: true,
  },
  {
    name: 'output_table',
    description: 'Present extracted or compiled data as a table the user can download as CSV or copy into a spreadsheet. Use it whenever the result is tabular. Include a source URL column when rows come from different pages.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        columns: { type: 'array', items: { type: 'string' } },
        rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
      },
      required: ['title', 'columns', 'rows'],
      additionalProperties: false,
    },
    readOnly: true,
    internal: true,
  },
  {
    name: 'snapshot',
    description: 'Get a compact semantic tree of the current page. Interactive elements are prefixed with [ref] numbers that other tools use. Call this before clicking or typing, and again after the page changes.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: 'read_page',
    description: 'Read the main content of the current page as Markdown. Each block is labelled [§n]; cite those labels when you quote or summarize the page.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: 'read_tab',
    description: 'Read another open tab\'s main content as Markdown without switching to it (for comparing tabs). Get ids from list_tabs.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Tab id' } },
      required: ['id'],
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'navigate',
    description: 'Open a URL (or search query) in the current tab.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute URL, domain, or search terms' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    description: 'Click an element by ref.',
    input_schema: { type: 'object', properties: { ref }, required: ['ref'], additionalProperties: false },
  },
  {
    name: 'type',
    description: 'Replace the text of an input/textarea by ref. Set submit=true to press Enter / submit its form. Cannot fill password or payment fields.',
    input_schema: {
      type: 'object',
      properties: { ref, text: { type: 'string' }, submit: { type: 'boolean' } },
      required: ['ref', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'select_option',
    description: 'Choose an option in a <select> by its value or visible text.',
    input_schema: {
      type: 'object',
      properties: { ref, value: { type: 'string' } },
      required: ['ref', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page up/down/top/bottom, or scroll an element (ref) into view.',
    input_schema: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] }, ref },
      additionalProperties: false,
    },
  },
  {
    name: 'go_back',
    description: 'Go back in the current tab history.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_tabs',
    description: 'List open tabs with their ids, titles, and URLs.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: 'open_tab',
    description: 'Open a URL in a new tab and switch to it.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'switch_tab',
    description: 'Switch to an open tab by id.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

// SuperAI tools are offered to the model only while the SuperAI connection is on (agent-host).
const DEFS_BY_NAME = new Map([...TOOL_DEFS, ...SUPERAI_TOOL_DEFS].map((d) => [d.name, d]));

export function isInternal(name) {
  return Boolean(DEFS_BY_NAME.get(name)?.internal);
}

/** S1: page-derived text is wrapped so the model treats it as data, never instructions. */
export function wrapUntrusted(text, url) {
  const safe = String(text).replace(/<\/?untrusted_page_content[^>]*>/gi, '');
  return `<untrusted_page_content source="${String(url).replace(/"/g, '%22')}">\n${safe}\n</untrusted_page_content>`;
}

export function isReadOnly(name) {
  return Boolean(DEFS_BY_NAME.get(name)?.readOnly);
}

/** Minimal JSON-Schema check for the flat object schemas above. */
export function validateInput(name, input) {
  const def = DEFS_BY_NAME.get(name);
  if (!def) return `unknown tool "${name}"`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
  const { properties, required = [] } = def.input_schema;
  for (const key of required) if (!(key in input)) return `missing required field "${key}"`;
  for (const [key, value] of Object.entries(input)) {
    if (key === '') continue; // some models emit {"": ...} for no-argument tools
    const prop = properties[key];
    if (!prop) continue; // extra fields (e.g. a model's "depth" hint) are ignored, not rejected
    if (prop.type === 'integer' && !Number.isInteger(value)) return `"${key}" must be an integer`;
    if (prop.type === 'string' && typeof value !== 'string') return `"${key}" must be a string`;
    if (prop.type === 'boolean' && typeof value !== 'boolean') return `"${key}" must be a boolean`;
    if (prop.enum && !prop.enum.includes(value)) return `"${key}" must be one of ${prop.enum.join(', ')}`;
    if (prop.type === 'array') {
      if (!Array.isArray(value)) return `"${key}" must be an array`;
      const inner = prop.items?.type;
      if (inner === 'string' && !value.every((v) => typeof v === 'string')) return `"${key}" must contain strings`;
      if (inner === 'array' && !value.every((row) => Array.isArray(row) && row.every((c) => typeof c === 'string' || typeof c === 'number'))) {
        return `"${key}" must be an array of string arrays`;
      }
      if (inner === 'object') {
        const itemProps = prop.items.properties ?? {};
        for (const item of value) {
          if (!item || typeof item !== 'object') return `"${key}" must contain objects`;
          for (const req of prop.items.required ?? []) if (!(req in item)) return `each "${key}" entry needs "${req}"`;
          for (const [k, v] of Object.entries(item)) {
            if (itemProps[k]?.enum && !itemProps[k].enum.includes(v)) return `"${k}" must be one of ${itemProps[k].enum.join(', ')}`;
          }
        }
      }
    }
  }
  return null;
}

/** Human-readable summary used in approval prompts and the activity log. */
export function describeCall(name, input, label = '') {
  const target = (ref) => (label ? `"${label.length > 40 ? label.slice(0, 39) + '…' : label}"` : `[${ref}]`);
  switch (name) {
    case 'navigate': return `Open ${input.url}`;
    case 'open_tab': return `Open new tab: ${input.url}`;
    case 'click': return label ? `Click ${target(input.ref)}` : `Click element [${input.ref}]`;
    case 'type': return `Type "${input.text}" into ${target(input.ref)}${input.submit ? ' and submit' : ''}`;
    case 'select_option': return `Select "${input.value}" in ${target(input.ref)}`;
    case 'scroll': return input.ref != null ? `Scroll to [${input.ref}]` : `Scroll ${input.direction ?? 'down'}`;
    case 'go_back': return 'Go back';
    case 'switch_tab': return `Switch to tab ${input.id}`;
    case 'snapshot': return 'Read page structure';
    case 'read_page': return 'Read page content';
    case 'list_tabs': return 'List open tabs';
    case 'read_tab': return `Read tab ${input.id}`;
    case 'propose_plan': return 'Propose a plan';
    case 'report_result': return 'Verify result';
    case 'output_table': return `Table: ${input.title}`;
    case 'superai_list_experts': return 'List SuperAI experts';
    case 'superai_run_task': return `Send to SuperAI: "${String(input.prompt ?? '').slice(0, 80)}${String(input.prompt ?? '').length > 80 ? '…' : ''}"`;
    case 'superai_list_skills': return 'List SuperAI skills';
    case 'superai_run_skill': return `Run SuperAI skill "${input.skill}" on: "${String(input.input ?? '').slice(0, 60)}${String(input.input ?? '').length > 60 ? '…' : ''}"`;
    case 'superai_get_task': return `Check SuperAI task ${input.task_id}`;
    default: return name;
  }
}

/**
 * Executes tools against a browser facade:
 *   { runInPage(fn, ...args), navigate(url), goBack(), listTabs(), openTab(url), switchTab(id) }
 */
export function createToolExecutor(browser) {
  const handlers = {
    snapshot: async () => wrapUntrusted(await browser.runInPage('snapshot'), browser.activeUrl?.() ?? ''),
    read_page: async () => wrapUntrusted(await browser.runInPage('readPage'), browser.activeUrl?.() ?? ''),
    read_tab: async ({ id }) => wrapUntrusted(await browser.readTab(id), browser.tabUrl?.(id) ?? ''),
    navigate: async ({ url }) => {
      const target = normalizeInput(url);
      await browser.navigate(target);
      return `navigated to ${target}`;
    },
    click: ({ ref: r }) => browser.runInPage('click', r),
    type: ({ ref: r, text, submit = false }) => browser.runInPage('type', r, text, submit),
    select_option: ({ ref: r, value }) => browser.runInPage('select', r, value),
    scroll: ({ direction = 'down', ref: r }) => browser.runInPage('scroll', direction, r ?? null),
    go_back: async () => {
      if (!(await browser.goBack())) throw new Error('no previous page in this tab');
      return 'went back';
    },
    list_tabs: () => browser.listTabs()
      .map((t) => `${t.active ? '*' : ' '} id=${t.id} "${t.title}" ${t.url}`).join('\n') || '(no tabs)',
    open_tab: async ({ url }) => {
      const target = normalizeInput(url);
      const id = await browser.openTab(target);
      return `opened tab ${id}: ${target}`;
    },
    switch_tab: ({ id }) => {
      if (!browser.switchTab(id)) throw new Error(`no tab with id ${id}`);
      return `switched to tab ${id}`;
    },
  };

  return async function execute(name, input) {
    const problem = validateInput(name, input);
    if (problem) throw new Error(`invalid input for ${name}: ${problem}`);
    const result = await handlers[name](input);
    return typeof result === 'string' ? result : JSON.stringify(result);
  };
}
