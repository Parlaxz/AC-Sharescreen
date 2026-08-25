// ScreenLink E2E full-flow scenario.
// Usage: node scripts/e2e-full-flow.mjs [--phase N]  (runs all phases >= N)
import { launchInstance, attachToPage, ui, sleep, log, waitFor } from "./e2e-harness.mjs";

const minPhase = parseInt(process.argv.find((a) => a === "--phase") ? process.argv[process.argv.indexOf("--phase") + 1] : "1", 10);
const GROUP_NAME = "E2E Weekly Group";

let pass = 0;
let fail = 0;
async function step(name, fn) {
  log(`▶ ${name}`);
  try {
    await fn();
    pass++;
    log(`✔ ${name}`);
  } catch (e) {
    fail++;
    log(`✘ ${name}: ${e.message}`);
    throw e;
  }
}

const procs = [];
const cdps = [];

async function main() {
  // ── Phase 1: launch both instances ──────────────────────────────────────
  if (minPhase <= 1) {
    await step("P1 launch alice (9222)", async () => {
      procs.push(await launchInstance("alice", 9222));
      cdps.push(await attachToPage(9222, "screenlink://"));
      const u = ui(cdps[0]);
      await u.waitForText("ScreenLink", 15_000);
    });
    await step("P1 launch bob (9223)", async () => {
      procs.push(await launchInstance("bob", 9223));
      cdps.push(await attachToPage(9223, "screenlink://"));
      const u = ui(cdps[1]);
      await u.waitForText("ScreenLink", 15_000);
    });
  }

  if (cdps.length < 2) throw new Error("Need both instances for later phases");

  const alice = ui(cdps[0]);
  const bob = ui(cdps[1]);

  // ── Phase 2: alice creates the group ────────────────────────────────────
  let inviteLink = "";
  if (minPhase <= 2) {
    await step("P2 alice opens Create group dialog", async () => {
      await alice.clickText("Create group");
      await alice.waitForText("Create a group");
    });

    await step("P2 alice names and creates the group", async () => {
      const okSet = await alice.eval(`
        (function () {
          const inputs = [...document.querySelectorAll('input')].filter(i => i.offsetParent !== null);
          const el = inputs[0];
          if (!el) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, ${JSON.stringify(GROUP_NAME)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()
      `);
      if (!okSet) throw new Error("no visible input for group name");
      await sleep(300);
      await alice.clickText("Create");
      await alice.waitForText(GROUP_NAME, 10_000);
    });

    await step("P2 invite link captured", async () => {
      inviteLink = await waitFor(async () => {
        const m = await alice.eval(
          `(document.body.innerText.match(/screenlink:\\/\\/group\\?\\S+/) || [])[0] || null`,
        );
        return m;
      }, 10_000);
      log("invite:", inviteLink.slice(0, 60) + "…");
    });
  }

  // ── Phase 3: bob joins via invite ───────────────────────────────────────
  if (minPhase <= 3 && inviteLink) {
    await step("P3 bob opens Join group dialog", async () => {
      await bob.clickText("Join group");
      await bob.waitForText("Join a group");
    });
    await step("P3 bob pastes invite and joins", async () => {
      const ok = await bob.eval(`
        (function () {
          const inputs = [...document.querySelectorAll('input')].filter(i => i.offsetParent !== null);
          const el = inputs[0];
          if (!el) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, ${JSON.stringify(inviteLink)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()
      `);
      if (!ok) throw new Error("no join input");
      await sleep(300);
      await bob.clickText("Join");
      await bob.waitForText(GROUP_NAME, 15_000);
    });
  }

  // ── Phase 4: mesh established — both see each other ─────────────────────
  if (minPhase <= 4 && inviteLink) {
    await step("P4 alice sees bob online", async () => {
      await waitFor(async () => {
        const t = await alice.eval("document.body.innerText");
        return /Bob|bob-\d|peer/i.test(t) ? true : null;
      }, 20_000);
    });
    await step("P4 bob sees alice online", async () => {
      await waitFor(async () => {
        const t = await bob.eval("document.body.innerText");
        return /Alice|alice/i.test(t) ? true : null;
      }, 20_000);
    });
  }

  log(`\nDONE: ${pass} passed, ${fail} failed (phases >= ${minPhase})`);
  cdps.forEach((c) => c.close());
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  log("FATAL:", e.message);
  cdps.forEach((c) => c.close());
  process.exit(1);
});
