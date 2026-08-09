import consola from "consola";
import $ from "dax";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import pc from "picocolors";

const INSTALL_DIR = "C:/PATH";

async function getLatestRelease(repo: string): Promise<any> {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { "User-Agent": "install-devel-script" },
    });
    if (!res.ok) {
        throw new Error(`Failed to fetch latest release for ${repo}: ${res.status}`);
    }
    return res.json();
}

async function downloadFile(url: string, dest: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to download ${url}: ${res.status}`);
    }
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

function findAsset(assets: any[], pattern: RegExp) {
    const asset = assets.find((a) => pattern.test(a.name));
    if (!asset) {
        throw new Error(`No asset found matching ${pattern}`);
    }
    return asset;
}

function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}

async function addToUserPath(dir: string): Promise<void> {
    const query = await $`reg query "HKCU\\Environment" /v Path`.quiet().noThrow();
    let current = "";
    if (query.code === 0) {
        const match = query.stdout.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/);
        if (match) {
            current = match[1].trim();
        }
    }

    if (!current.toLowerCase().includes(dir.toLowerCase())) {
        const updated = current ? `${current};${dir}` : dir;
        await $`reg add "HKCU\\Environment" /v Path /t REG_EXPAND_SZ /d ${updated} /f`.quiet();
    }

    if (!process.env.PATH?.toLowerCase().includes(dir.toLowerCase())) {
        process.env.PATH = `${process.env.PATH};${dir}`;
    }
}

async function main() {
    await mkdir(INSTALL_DIR, { recursive: true });
    const tmp = await mkdtemp(join(tmpdir(), "bootstrap-"));

    consola.start("Installing LLVM...");
    const llvm = await getLatestRelease("llvm/llvm-project");
    const llvmAsset = findAsset(llvm.assets, /^LLVM-.*-win64\.exe$/);
    const llvmPath = join(tmp, llvmAsset.name);
    await downloadFile(llvmAsset.browser_download_url, llvmPath);
    await $`${llvmPath} /S`;
    consola.success("LLVM installed");

    consola.start("Installing MSYS2...");
    const msys2 = await getLatestRelease("msys2/msys2-installer");
    const msys2Asset = findAsset(msys2.assets, /x86_64\.exe$/);
    const msys2Path = join(tmp, msys2Asset.name);
    await downloadFile(msys2Asset.browser_download_url, msys2Path);
    await $`${msys2Path} in --confirm-command --accept-messages --root C:/msys64`;
    consola.success("MSYS2 installed");

    consola.start("Installing CMake...");
    const cmake = await getLatestRelease("Kitware/CMake");
    const cmakeAsset = findAsset(cmake.assets, /windows-x86_64\.msi$/);
    const cmakePath = join(tmp, cmakeAsset.name);
    await downloadFile(cmakeAsset.browser_download_url, cmakePath);
    await $`msiexec.exe /i ${cmakePath} /qn ADD_CMAKE_TO_PATH=System`;
    consola.success("CMake installed");

    consola.start("Installing Rust (rustup)...");
    const rustupPath = join(tmp, "rustup-init.exe");
    await downloadFile("https://win.rustup.rs/x86_64", rustupPath);
    await $`${rustupPath} -y --default-toolchain stable-x86_64-pc-windows-msvc`;
    const cargoBin = join(process.env.USERPROFILE ?? "", ".cargo", "bin");
    await addToUserPath(cargoBin);
    consola.success("Rust installed");

    consola.start("Installing cargo-binstall...");
    const binstall = await getLatestRelease("cargo-bins/cargo-binstall");
    const binstallAsset = findAsset(binstall.assets, /x86_64-pc-windows-msvc\.zip$/);
    const binstallZip = join(tmp, "cargo-binstall.zip");
    await downloadFile(binstallAsset.browser_download_url, binstallZip);
    await $`tar -xf ${binstallZip} -C ${cargoBin}`;
    consola.success("cargo-binstall installed");

    consola.start("Installing uv...");
    const uv = await getLatestRelease("astral-sh/uv");
    const uvAsset = findAsset(uv.assets, /x86_64-pc-windows-msvc\.zip$/);
    const uvZip = join(tmp, "uv.zip");
    await downloadFile(uvAsset.browser_download_url, uvZip);
    const uvBin = join(process.env.LOCALAPPDATA ?? "", "uv", "bin");
    await mkdir(uvBin, { recursive: true });
    await $`tar -xf ${uvZip} -C ${uvBin}`;
    await addToUserPath(uvBin);
    consola.success("uv installed");

    consola.start("Installing ninja...");
    const ninja = await getLatestRelease("ninja-build/ninja");
    const ninjaAsset = findAsset(ninja.assets, /win\.zip$/);
    const ninjaZip = join(tmp, "ninja.zip");
    await downloadFile(ninjaAsset.browser_download_url, ninjaZip);
    await $`tar -xf ${ninjaZip} -C ${INSTALL_DIR}`;
    consola.success("ninja installed");

    consola.start("Installing nasm...");
    const nasmIndexHtml = await (await fetch("https://www.nasm.us/pub/nasm/releasebuilds/")).text();
    const nasmVersions = [...nasmIndexHtml.matchAll(/href="(\d+(?:\.\d+)+)\/"/g)].map((m) => m[1]!);
    const nasmLatest = nasmVersions.sort(compareVersions).at(-1);
    if (!nasmLatest) {
        throw new Error("Could not determine latest NASM version");
    }

    const nasmZip = join(tmp, "nasm.zip");
    await downloadFile(
        `https://www.nasm.us/pub/nasm/releasebuilds/${nasmLatest}/win64/nasm-${nasmLatest}-win64.zip`,
        nasmZip,
    );
    const nasmExtract = join(tmp, "nasm_extract");
    await mkdir(nasmExtract, { recursive: true });
    await $`tar -xf ${nasmZip} -C ${nasmExtract}`;
    await $`cmd /c copy /Y "${join(nasmExtract, `nasm-${nasmLatest}`, "*.exe")}" "${INSTALL_DIR}"`;
    consola.success("nasm installed");

    await addToUserPath(INSTALL_DIR);

    consola.start("Installing cargo tools via binstall...");
    await $`cargo binstall -y cargo-about cargo-feature cargo-machete cargo-license cargo-msrv cargo-outdated cargo-semver-checks cargo-sort cargo-sort-derives cargo-spellcheck cargo-sweep cargo-modules cbindgen ripgrep sd`;
    consola.success("cargo tools installed");

    const toolchains = [
        "stable-x86_64-pc-windows-msvc",
        "stable-x86_64-pc-windows-gnu",
        "stable-x86_64-pc-windows-gnullvm",
        "nightly-x86_64-pc-windows-msvc",
        "nightly-x86_64-pc-windows-gnu",
        "nightly-x86_64-pc-windows-gnullvm",
    ];
    for (const t of toolchains) {
        consola.start(`Installing Rust toolchain ${t}...`);
        await $`rustup toolchain install ${t}`;
    }

    await $`uv python install --default 3`;
    await $`uv tool install meson`;

    consola.success(pc.green("Development environment setup complete."));
}

$.setPrintCommand(true);
await main().catch((err) => {
    consola.error(err);
    process.exit(1);
});
