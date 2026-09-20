import { describe, expect, it } from "vitest";
import { MISSION_RECIPE, parseMissionObjective } from "../packages/contracts/src/index.js";
import {
  DEFAULT_REVIEW_FINDINGS,
  admissionRequest,
  missionObjective,
  parseCommand,
  type Command,
} from "../services/kernel/src/channel/telegram/commands.js";

const TASK = "d10442d5-f208-859d-af74-c4d16a9d379f";
const mission = (text: string) => {
  const c = parseCommand(text);
  if (c.kind !== "MISSION") throw new Error(`expected a mission command for ${JSON.stringify(text)}, got ${c.kind}`);
  return c;
};

describe("KJ-P4A command grammar", () => {
  it("parses exactly the four commands", () => {
    expect(parseCommand("/status")).toEqual({ kind: "STATUS" });
    expect(parseCommand(`/task ${TASK}`)).toEqual({ kind: "TASK", taskId: TASK });
    expect(parseCommand("/brief jonnyallum/kerneljson")).toEqual({ kind: "MISSION", command: "BRIEF", repo: "jonnyallum/kerneljson", findings: null });
    expect(parseCommand("/review jonnyallum/kerneljson findings=3")).toEqual({ kind: "MISSION", command: "REVIEW", repo: "jonnyallum/kerneljson", findings: 3 });
  });

  it("tolerates case, surrounding whitespace, a bot-name suffix and either argument order", () => {
    expect(parseCommand("  /STATUS  ")).toEqual({ kind: "STATUS" });
    expect(parseCommand("/status@KernelJsonBot")).toEqual({ kind: "STATUS" });
    expect(parseCommand("/review findings=2 o/r")).toMatchObject({ repo: "o/r", findings: 2 });
    expect(parseCommand(`/task ${TASK.toUpperCase()}`)).toEqual({ kind: "TASK", taskId: TASK });
  });

  it("treats everything else as malformed, deterministically", () => {
    const bad = [
      "", "   ", "hello", "status", "/", "/help", "/start", "/cancel " + TASK, "/approve",
      "/status now", "/task", `/task ${TASK} extra`, "/task not-a-uuid",
      "/brief", "/brief a b", "/brief o/r findings=3 findings=4", "/brief o/r o/x",
      "/brief o/r findings=0", "/brief o/r findings=13", "/brief o/r findings=three", "/brief o/r findings=", "/brief o/r findings=1.5",
      "/brief https://github.com/o/r", "/brief ../etc/passwd", "/brief o/r;rm", "/brief o/r$(id)", "/brief -o/r", "/brief o/..",
      "/review findings=3", "/x".repeat(200),
    ];
    for (const text of bad) expect(parseCommand(text), JSON.stringify(text)).toEqual({ kind: "MALFORMED" });
  });

  it("never interprets free text: a sentence is malformed even if it mentions a command", () => {
    expect(parseCommand("please /status")).toEqual({ kind: "MALFORMED" });
    expect(parseCommand("/brief o/r and also delete everything")).toEqual({ kind: "MALFORMED" });
  });
});

describe("KJ-P4A /brief and /review map onto the existing repo-analysis mission path", () => {
  it("uses the existing mission recipe and nothing else", () => {
    for (const text of ["/brief o/r", "/review o/r", "/brief o/r findings=4"]) {
      expect(admissionRequest(mission(text)).recipe).toBe(MISSION_RECIPE);
    }
  });

  it("/brief with no count asks for the mission's own default brief", () => {
    const c = mission("/brief jonnyallum/kerneljson");
    expect(missionObjective(c)).toBe("jonnyallum/kerneljson");
    const parsed = parseMissionObjective(missionObjective(c));
    expect(parsed.repo).toBe("jonnyallum/kerneljson");
    expect(parsed.contract).toMatchObject({ requestedFindings: null, minFindings: 1, maxFindings: 8 });
    expect(parsed.question).toMatch(/architecture/);
  });

  it("/brief findings=N puts an exact-count contract on the objective", () => {
    const parsed = parseMissionObjective(missionObjective(mission("/brief o/r findings=2")));
    expect(parsed.contract).toMatchObject({ requestedFindings: 2, minFindings: 2, maxFindings: 2 });
  });

  it("/review defaults to three findings, every one citing exact evidence", () => {
    const c = mission("/review o/r");
    const objective = missionObjective(c);
    expect(objective.startsWith("o/r findings=3 ")).toBe(true);
    const parsed = parseMissionObjective(objective);
    expect(parsed.contract).toMatchObject({ requestedFindings: DEFAULT_REVIEW_FINDINGS, minFindings: 3, maxFindings: 3 });
    expect(parsed.question).toMatch(/highest-value concrete improvements/);
    expect(parsed.question).toMatch(/cite exact repository evidence/);
  });

  it("/review findings=N asks for exactly N, and the question says N", () => {
    const parsed = parseMissionObjective(missionObjective(mission("/review o/r findings=5")));
    expect(parsed.contract.requestedFindings).toBe(5);
    expect(parsed.question).toMatch(/identify the 5 highest-value/);
  });

  it("every objective the grammar can produce is one the door will admit", () => {
    for (let n = 1; n <= 12; n += 1) {
      for (const cmd of ["brief", "review"]) {
        expect(() => parseMissionObjective(missionObjective(mission(`/${cmd} owner/repo findings=${n}`)))).not.toThrow();
      }
    }
    expect(parseCommand("/review o/r findings=99")).toEqual({ kind: "MALFORMED" });
  });

  it("a Command is a closed union: no command carries free text", () => {
    const all: Command[] = [
      parseCommand("/status"), parseCommand(`/task ${TASK}`), parseCommand("/brief o/r"), parseCommand("nonsense"),
    ];
    for (const c of all) expect(Object.keys(c).every((k) => ["kind", "command", "repo", "findings", "taskId"].includes(k))).toBe(true);
  });
});
