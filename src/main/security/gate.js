// Security gate: every tool call from the side panel or MCP passes through
// review() before it touches a page. Verdicts: allow / confirm / block.

import { normalizeInput } from '../url.js';
import {
  siteTier, hostOf, hostAllowed, isHighRiskElement, isHighRiskName, isBenignGetForm, sensitiveTextKind, exfiltrationSignal,
} from './policy.js';

const PAGE_TOOLS = new Set(['snapshot', 'read_page', 'click', 'type', 'select_option', 'scroll']);

/**
 * @param {object} deps
 * @param {() => {sensitive: string[], blocked: string[]}} deps.sites
 * @param {() => string} deps.activeUrl
 * @param {(ref: number) => Promise<object>} deps.inspect  element facts from the page
 * @param {() => string} [deps.searchTemplate]
 */
export function createGate({ sites, activeUrl, inspect, tabUrl = () => '', searchTemplate = () => '' }) {
  function navigationVerdict(rawUrl, task) {
    const url = normalizeInput(rawUrl, searchTemplate() || undefined);
    const host = hostOf(url);
    const tier = siteTier(url, sites());
    if (tier === 'blocked') return { action: 'block', reason: `${host} is on the blocked-sites list (S5)` };
    if (!host) return { action: 'allow' };
    const allowed = hostAllowed(host, task.allowedDomains);
    if (!allowed) {
      const leak = exfiltrationSignal(url, task.recentContent, { goal: task.goal });
      if (leak) {
        return { action: 'block', reason: `Possible data exfiltration to ${host}: ${leak} (S4)`, event: 'sensitive_action_blocked' };
      }
      return {
        action: 'confirm', highRisk: true, grant: host,
        reason: `${host} was not part of the task. Allow the agent to go there? (S3 goal lock)`,
      };
    }
    if (tier === 'sensitive') {
      return { action: 'confirm', highRisk: true, reason: `${host} is a sensitive site (banking, payment, mail, or admin)` };
    }
    return { action: 'allow' };
  }

  async function elementFacts(ref) {
    try {
      return await inspect(ref);
    } catch {
      return null; // the executor will report the missing ref
    }
  }

  /** Adds the element's visible name so approvals read "Click "送出報名"", not "Click [4]". */
  return async function review(call, task) {
    const holder = {};
    const verdict = await decide(call, task, holder);
    return holder.facts?.name ? { ...verdict, label: holder.facts.name } : verdict;
  };

  async function decide(call, task, holder) {
    const { name, input } = call;

    if (name === 'navigate' || name === 'open_tab') return navigationVerdict(input.url, task);
    // Handing work (and whatever data the prompt carries) to SuperAI is always confirmed on its own.
    if (name === 'superai_run_task') return { action: 'confirm', reason: 'Sends this task and its data to SuperAI' };
    if (name === 'superai_run_skill') return { action: 'confirm', reason: `Sends this data to SuperAI to run the skill "${input.skill}"` };
    if (name === 'read_tab') {
      const target = tabUrl(input.id);
      if (siteTier(target, sites()) === 'blocked') return { action: 'block', reason: `${hostOf(target)} is on the blocked-sites list; the agent may not read it (S5)` };
      return { action: 'allow' };
    }

    if (!PAGE_TOOLS.has(name)) return { action: 'allow' };

    const url = activeUrl();
    const tier = siteTier(url, sites());
    if (tier === 'blocked') {
      return { action: 'block', reason: `${hostOf(url)} is on the blocked-sites list; the agent may not read or operate it (S5)` };
    }
    if (name === 'snapshot' || name === 'read_page' || name === 'scroll') return { action: 'allow' };

    const facts = name === 'type' || name === 'click' || name === 'select_option' ? await elementFacts(input.ref) : null;
    holder.facts = facts;
    if (facts?.captcha) {
      return { action: 'block', reason: 'CAPTCHA detected; the user must complete it (S8)', event: 'sensitive_action_blocked' };
    }

    // S4: a form that submits to a domain outside the task must not carry page data.
    const submits = (name === 'type' && input.submit) || (name === 'click' && facts && isHighRiskElement(facts));
    if (submits && facts?.formAction) {
      const target = hostOf(facts.formAction);
      if (target && target !== hostOf(url) && !hostAllowed(target, task.allowedDomains)) {
        const payload = `${facts.formAction}${facts.formAction.includes('?') ? '&' : '?'}${facts.formValues ?? ''}${name === 'type' ? `&typed=${encodeURIComponent(input.text)}` : ''}`;
        const leak = exfiltrationSignal(payload, task.recentContent, { goal: task.goal });
        if (leak) return { action: 'block', reason: `Form submits to ${target}: ${leak} (S4)`, event: 'sensitive_action_blocked' };
        return { action: 'confirm', highRisk: true, grant: target, reason: `This form sends data to ${target}, which is not part of the task (S4)` };
      }
    }

    if (name === 'type') {
      const secret = sensitiveTextKind(input.text);
      if (secret) return { action: 'block', reason: `Refusing to type a ${secret} (S8)`, event: 'sensitive_action_blocked' };
      if (facts?.sensitiveField) {
        return { action: 'block', reason: `${facts.sensitiveField} fields must be filled in by the user (S8)`, event: 'sensitive_action_blocked' };
      }
      if (input.submit && !isBenignGetForm(facts ?? {}, url)) return { action: 'confirm', highRisk: true, reason: 'This submits a form (S6)' };
    }

    if (name === 'click' && facts) {
      if (facts.href) {
        const target = hostOf(facts.href);
        if (target && !hostAllowed(target, task.allowedDomains) && target !== hostOf(url)) {
          const verdict = navigationVerdict(facts.href, task);
          if (verdict.action !== 'allow') return verdict;
        }
      }
      const risky = isBenignGetForm(facts, url) ? isHighRiskName(facts.name) : isHighRiskElement(facts);
      if (risky) {
        return { action: 'confirm', highRisk: true, reason: `"${facts.name || facts.tag}" looks like a submit/send/pay/delete action (S6)` };
      }
    }

    if (tier === 'sensitive') {
      return { action: 'confirm', highRisk: true, reason: `${hostOf(url)} is a sensitive site; every action needs your approval (S5)` };
    }
    return { action: 'allow' };
  }
}
