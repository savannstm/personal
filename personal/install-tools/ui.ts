// Live terminal UI: one row per running task (spinner, name, stage progress bar, elapsed, current stage + detail).
// Finished tasks are printed above the live region as permanent lines. Without a TTY it degrades to plain result lines.
import { AsyncLocalStorage } from "node:async_hooks";
import console from "node:console";
import process from "node:process";

interface Task {
    name: string;
    /** Stage names known up front: the bar advances one slice per stage. Empty = progress comes only from bytes/progress(). */
    plan: string[];
    stage: number;
    label: string;
    /** Free-form text from progress(), shown after the label. */
    detail: string;
    /** Explicit 0..1 progress inside the current stage (progress()). */
    fraction?: number;
    /** Bytes of the downloads running in the current stage; `unknown` counts those without a Content-Length. */
    bytesDone: number;
    bytesTotal: number;
    unknown: number;
    started: number;
}

export type ResultKind = "current" | "done" | "failed";

const storage = new AsyncLocalStorage<Task>(),
    tasks = new Set<Task>(),
    out = process.stdout,
    live = out.isTTY === true,
    color = live && !process.env.NO_COLOR,
    SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    BAR_WIDTH = 20,
    BOUNCE_WIDTH = 5,
    NAME_WIDTH_MAX = 28,
    FRAME_MS = 80,
    RESULTS: Record<ResultKind, { code: string; label: string; symbol: string }> = {
        current: { code: "2", label: "up to date", symbol: "●" },
        done: { code: "32", label: "done", symbol: "✔" },
        failed: { code: "31", label: "error", symbol: "✖" },
    };

let rendered = 0,
    frame = 0,
    timer: NodeJS.Timeout | undefined;

const paint = (code: string, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text),
    megabytes = (bytes: number) => (bytes / 1048576).toFixed(1),
    clip = (text: string, width: number) =>
        text.length <= width ? text : width > 0 ? `${text.slice(0, width - 1)}…` : "";

if (live) {
    process.on("exit", () => void out.write("\x1b[?25h"));
    process.on("SIGINT", () => process.exit(130));
}

function fraction(task: Task): number | undefined {
    const inner =
        task.unknown === 0 && task.bytesTotal > 0 ? Math.min(task.bytesDone / task.bytesTotal, 1) : task.fraction;

    return task.plan.length === 0 ? inner : Math.min(task.stage + (inner ?? 0), task.plan.length) / task.plan.length;
}

function bar(ratio: number | undefined): string {
    if (ratio === undefined) {
        // No measurable progress: a block bouncing across the bar.
        const span = BAR_WIDTH - BOUNCE_WIDTH,
            step = frame % (span * 2),
            pos = step < span ? step : span * 2 - step;
        return paint("2", "░".repeat(pos)) + paint("36", "█".repeat(BOUNCE_WIDTH)) + paint("2", "░".repeat(span - pos));
    }

    const filled = Math.round(ratio * BAR_WIDTH);
    return paint("36", "█".repeat(filled)) + paint("2", "░".repeat(BAR_WIDTH - filled));
}

function row(task: Task, nameWidth: number, columns: number): string {
    const ratio = fraction(task),
        percent = ratio === undefined ? "   …" : `${Math.round(ratio * 100)}%`.padStart(4),
        elapsed = `${Math.floor((Date.now() - task.started) / 1000)}s`.padStart(4),
        transfer =
            task.bytesDone > 0
                ? `${megabytes(task.bytesDone)}${task.unknown === 0 ? `/${megabytes(task.bytesTotal)}` : ""} MB`
                : task.detail,
        steps = task.plan.length > 0 ? `[${task.stage + 1}/${task.plan.length}] ` : "",
        text = `${steps}${task.label}${transfer ? ` · ${transfer}` : ""}`,
        // spinner, name, bar, percent, elapsed and the separating spaces
        fixed = 2 + nameWidth + 1 + BAR_WIDTH + 1 + 4 + 1 + 4 + 2;

    return (
        `${paint("36", SPINNER[frame % SPINNER.length]!)} ${clip(task.name, nameWidth).padEnd(nameWidth)} ` +
        `${bar(ratio)} ${percent} ${paint("2", elapsed)}  ${paint("2", clip(text, columns - fixed))}`
    );
}

/** Redraws the live region, optionally printing a permanent line above it first. */
function flush(line?: string) {
    const columns = Math.max((out.columns ?? 80) - 1, 40),
        visible = [...tasks].slice(0, Math.max((out.rows ?? 30) - 3, 3)),
        hidden = tasks.size - visible.length,
        nameWidth = Math.min(Math.max(0, ...visible.map((task) => task.name.length)), NAME_WIDTH_MAX),
        lines = visible.map((task) => row(task, nameWidth, columns));

    if (hidden > 0) {
        lines.push(paint("2", `  … and ${hidden} more`));
    }

    out.write(
        `${rendered > 0 ? `\x1b[${rendered}F` : ""}\x1b[J${line === undefined ? "" : `${line}\n`}${lines
            .map((text) => `${text}\n`)
            .join("")}`,
    );
    rendered = lines.length;
}

function start() {
    if (live && !timer) {
        out.write("\x1b[?25l");
        timer = setInterval(() => {
            frame++;
            flush();
        }, FRAME_MS);
    }
}

function stopIfIdle() {
    if (live && tasks.size === 0 && timer) {
        clearInterval(timer);
        timer = undefined;
        flush();
        out.write("\x1b[?25h");
    }
}

/** Runs `fn` with a live row. Stage/progress calls made anywhere under `fn` (even in nested async calls) update that row. */
export async function track<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const task: Task = {
        bytesDone: 0,
        bytesTotal: 0,
        detail: "",
        label: "working",
        name,
        plan: [],
        stage: 0,
        started: Date.now(),
        unknown: 0,
    };

    tasks.add(task);
    start();
    try {
        return await storage.run(task, fn);
    } finally {
        tasks.delete(task);
        stopIfIdle();
    }
}

/** Like `track`, but joins the row of the enclosing task if there is one. */
export const inTask = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
    storage.getStore() ? fn() : track(name, fn);

/** Declares the stages of the current task; the bar fills one slice per stage. */
export function plan(stages: string[]) {
    const task = storage.getStore();
    if (task) {
        task.plan = stages;
        task.stage = 0;
        task.label = stages[0] ?? task.label;
    }
}

/** Moves the current task to `name`. Repeating the current stage is a no-op, so parallel downloads don't reset each other. */
export function stage(name: string) {
    const task = storage.getStore();
    if (!task || task.label === name) {
        return;
    }

    const index = task.plan.indexOf(name);
    if (index >= 0) {
        task.stage = index;
    }
    task.label = name;
    task.detail = "";
    task.fraction = undefined;
    task.bytesDone = task.bytesTotal = task.unknown = 0;
}

/** Explicit progress inside the current stage (e.g. 3 of 7 installers). */
export function progress(done: number, total: number, detail = "") {
    const task = storage.getStore();
    if (task) {
        task.fraction = total > 0 ? done / total : undefined;
        task.detail = detail;
    }
}

/** Registers a download with the current task; returns the callback to feed it received chunk sizes. */
export function transfer(total: number): (bytes: number) => void {
    const task = storage.getStore();
    if (!task) {
        return () => {};
    }
    task.bytesTotal += total;
    if (total === 0) {
        task.unknown++;
    }
    return (bytes) => void (task.bytesDone += bytes);
}

/** Prints a permanent line above the live region. */
export function log(line: string, error = false) {
    if (live) {
        flush(line);
    } else {
        (error ? console.error : console.log)(line);
    }
}

/** Prints a finished task's outcome line. */
export function result(kind: ResultKind, name: string, detail = "") {
    const { code, label, symbol } = RESULTS[kind];
    log(
        live
            ? `${paint(code, symbol)} ${name}${detail ? ` ${paint("2", detail)}` : ""}`
            : `[${label}] ${name}${detail ? `: ${detail}` : ""}`,
        kind === "failed",
    );
}
