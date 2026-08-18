import { type Args, flagBool } from "../core/args.ts";
import {
  describeName, getAccount, listAccounts, loadRegistry, mutateRegistry, resolveName,
} from "../core/registry.ts";
import { RESERVED_NAMES } from "../core/reserved.ts";
import { HOOK_VERSION } from "../shell/hook.ts";
import { UserError } from "../core/util.ts";
import { c, out, success, table } from "../ui/io.ts";

const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export function cmdAlias(args: Args): number {
  const reg = loadRegistry();
  const [name, ...wanted] = args.positionals;

  if (!name) {
    const rows = listAccounts(reg)
      .filter((acc) => acc.aliases?.length)
      .map((acc) => [acc.slug, (acc.aliases ?? []).join(", ")]);
    if (!rows.length) {
      out(c.dim("No aliases yet."));
      out();
      out(`  ${c.bold("Give an account a short name:")}  ${c.cyan("cs alias work w")}`);
      out(`  ${c.dim("Then switch with:")}                ${c.cyan("cs w")}`);
      return 0;
    }
    out(table(["account", "aliases"], rows));
    out();
    out(c.dim("Switch with either the account name or any of its aliases: ") + c.cyan("cs w"));
    return 0;
  }

  const acc = getAccount(reg, name);

  if (flagBool(args, "clear")) {
    const had = acc.aliases ?? [];
    if (!had.length) {
      out(c.dim(`${acc.slug} has no aliases.`));
      return 0;
    }
    mutateRegistry((fresh) => {
      const target = fresh.accounts[acc.slug];
      if (target) delete target.aliases;
    });
    success(`Cleared ${had.length} alias${had.length === 1 ? "" : "es"} on ${c.bold(acc.slug)}: ${had.join(", ")}`);
    return 0;
  }

  if (!wanted.length) {
    out(
      acc.aliases?.length
        ? `${c.bold(acc.slug)} also answers to: ${acc.aliases.map((a) => c.cyan(a)).join(", ")}`
        : `${c.bold(acc.slug)} ${c.dim("has no aliases.")}`,
    );
    out(c.dim(`  Add one: cs alias ${acc.slug} ${acc.slug.slice(0, 1)}`));
    return 0;
  }

  const added = wanted.map((raw) => validateAlias(reg, acc.slug, raw));
  const next = [...new Set([...(acc.aliases ?? []), ...added])].sort();

  mutateRegistry((fresh) => {
    const target = fresh.accounts[acc.slug];
    if (!target) throw new UserError(`Account "${acc.slug}" disappeared while updating aliases.`);
    // Re-check under the lock: another terminal may have claimed the name.
    for (const alias of added) {
      const owner = resolveName(fresh, alias);
      if (owner && owner.slug !== acc.slug) {
        throw new UserError(`"${alias}" was just claimed by "${owner.slug}".`);
      }
    }
    target.aliases = next;
  });

  success(`${c.bold(acc.slug)} now answers to: ${next.map((a) => c.cyan(a)).join(", ")}`);
  out(`  ${c.dim("Try:")} ${c.cyan(`cs ${added[0]}`)}`);
  if (Number(process.env.CLAUDESWITCH_HOOK_VERSION ?? 0) < HOOK_VERSION) {
    out(
      `  ${c.dim("This shell has an older hook, so bare")} ${c.cyan(`cs ${added[0]}`)} ${c.dim("needs")} ` +
        `${c.cyan("source ~/.zshrc")} ${c.dim("first — or use")} ${c.cyan(`cs use ${added[0]}`)}${c.dim(".")}`,
    );
  }
  return 0;
}

export function cmdUnalias(args: Args): number {
  const reg = loadRegistry();
  if (!args.positionals.length) {
    throw new UserError("Usage: claudeswitch unalias <alias…>", "Remove all of an account's aliases: cs alias <name> --clear");
  }

  const removals = new Map<string, string[]>();
  for (const raw of args.positionals) {
    const alias = raw.trim().toLowerCase();
    const owner = listAccounts(reg).find((acc) => acc.aliases?.includes(alias));
    if (!owner) {
      throw new UserError(
        `"${alias}" is not an alias.`,
        reg.accounts[alias]
          ? `It is an account name — rename it with: cs rename ${alias} <new-name>`
          : "See what exists with: cs alias",
      );
    }
    removals.set(owner.slug, [...(removals.get(owner.slug) ?? []), alias]);
  }

  mutateRegistry((fresh) => {
    for (const [slug, aliases] of removals) {
      const target = fresh.accounts[slug];
      if (!target) continue;
      target.aliases = (target.aliases ?? []).filter((a) => !aliases.includes(a));
      if (!target.aliases.length) delete target.aliases;
    }
  });

  for (const [slug, aliases] of removals) {
    success(`Removed ${aliases.join(", ")} from ${c.bold(slug)}`);
  }
  return 0;
}

function validateAlias(reg: ReturnType<typeof loadRegistry>, slug: string, raw: string): string {
  const alias = raw.trim().toLowerCase();
  if (!ALIAS_RE.test(alias)) {
    throw new UserError(
      `Invalid alias: ${JSON.stringify(raw)}`,
      "Use 1-32 chars: lowercase letters, digits, dot, dash, underscore; must start with a letter or digit.",
    );
  }
  if (RESERVED_NAMES.has(alias)) {
    throw new UserError(
      `"${alias}" is a claudeswitch command, so it cannot be an alias.`,
      "Pick another one — `cs <alias>` has to stay unambiguous.",
    );
  }
  if (alias === slug) {
    throw new UserError(`"${alias}" is already this account's name.`);
  }
  const owner = resolveName(reg, alias);
  if (owner && owner.slug !== slug) {
    throw new UserError(
      `"${alias}" already refers to ${describeName(owner)}.`,
      `Free it first: cs unalias ${alias}`,
    );
  }
  return alias;
}
