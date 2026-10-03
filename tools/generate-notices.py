"""Collect release license texts without publishing local paths or credentials.

Run after `npm ci` and `cargo fetch`:
    python tools/generate-notices.py --fetch-missing

The default scope is the Windows release dependency graph (including build
dependencies), plus production npm packages. Exact upstream commits are used
when a published crate omitted its license files. Downloads are cached under
work/notices-cache; subsequent runs can omit --fetch-missing.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LICENSE_NAME = re.compile(r"^(licen[cs]e|copying|copyright|notice|authors)([.\-_]|$)", re.I)


def read_text(path: Path) -> str:
    return path.read_bytes().decode("utf-8-sig", errors="replace").replace("\r\n", "\n").strip()


def license_files(folder: Path) -> list[Path]:
    return sorted(path for path in folder.rglob("*") if path.is_file()
                  and LICENSE_NAME.match(path.name)
                  and "node_modules" not in path.relative_to(folder).parts)


class Downloads:
    def __init__(self, enabled: bool):
        self.enabled = enabled
        self.folder = ROOT / "work" / "notices-cache"

    def get(self, url: str) -> bytes:
        key = hashlib.sha256(url.encode()).hexdigest()
        path = self.folder / key
        if path.is_file():
            return path.read_bytes()
        if not self.enabled:
            raise RuntimeError("missing cached upstream license; rerun with --fetch-missing")
        request = urllib.request.Request(url, headers={"User-Agent": "Dropping-license-notices/1"})
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read(32 * 1024 * 1024 + 1)
        if len(data) > 32 * 1024 * 1024:
            raise RuntimeError("upstream license download exceeds 32 MiB")
        self.folder.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return data


def upstream_licenses(package: dict, folder: Path, downloads: Downloads) -> list[tuple[str, str]]:
    vcs_path = folder / ".cargo_vcs_info.json"
    repository = package.get("repository") or ""
    match = re.match(r"https://github.com/([^/]+/[^/#]+)", repository)
    if not vcs_path.is_file() or not match:
        return []
    vcs = json.loads(vcs_path.read_text(encoding="utf-8"))
    sha = vcs.get("git", {}).get("sha1", "")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        return []
    repository = match[1].removesuffix(".git")
    tree_url = f"https://api.github.com/repos/{repository}/git/trees/{sha}?recursive=1"
    tree = json.loads(downloads.get(tree_url))
    if tree.get("truncated"):
        raise RuntimeError("upstream tree is truncated; license discovery needs manual review")
    package_dir = Path(vcs.get("path_in_vcs", ""))
    ancestors = {str(path).replace("\\", "/") for path in [package_dir, *package_dir.parents]}
    ancestors.add(".")
    matches = []
    for item in tree["tree"]:
        file = Path(item["path"])
        if item["type"] == "blob" and LICENSE_NAME.match(file.name) and file.parent.as_posix() in ancestors:
            matches.append(item["path"])
    result = []
    for file in sorted(matches):
        url = f"https://raw.githubusercontent.com/{repository}/{sha}/{file}"
        result.append((url, downloads.get(url).decode("utf-8-sig").replace("\r\n", "\n").strip()))
    return result


def source_copyrights(folder: Path) -> str:
    lines = set()
    for path in folder.rglob("*"):
        if path.is_file() and path.suffix in {".rs", ".c", ".h", ".S"}:
            with path.open(encoding="utf-8", errors="replace") as source:
                for _, line in zip(range(80), source):
                    if re.search(r"copyright\s*(?:\(c\)|©|[0-9])", line, re.I):
                        lines.add(line.strip().lstrip("/*# ").rstrip("*/ "))
    return "\n".join(sorted(lines))


def cargo_packages(target: str) -> list[dict]:
    command = ["cargo", "metadata", "--locked", "--offline", "--format-version", "1",
               "--manifest-path", str(ROOT / "src-tauri" / "Cargo.toml")]
    if target != "all":
        command += ["--filter-platform", target]
    metadata = json.loads(subprocess.check_output(command, cwd=ROOT))
    nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
    pending = [metadata["resolve"]["root"]]
    included = set()
    while pending:
        package = pending.pop()
        if package in included:
            continue
        included.add(package)
        pending.extend(dep["pkg"] for dep in nodes[package]["deps"])
    return sorted((package for package in metadata["packages"]
                   if package["id"] in included and package.get("source")),
                  key=lambda package: (package["name"], package["version"]))


def npm_packages() -> list[tuple[dict, Path]]:
    lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
    result = []
    for location, details in sorted(lock["packages"].items()):
        if not location or details.get("dev"):
            continue
        folder = ROOT / location
        package = json.loads((folder / "package.json").read_text(encoding="utf-8"))
        if package["version"] != details["version"]:
            raise RuntimeError(f"npm {package['name']} version differs from package-lock.json; run npm ci")
        result.append((package, folder))
    return result


def webview_sdk(package: dict, folder: Path, downloads: Downloads) -> dict:
    vcs = json.loads((folder / ".cargo_vcs_info.json").read_text(encoding="utf-8"))
    sha = vcs["git"]["sha1"]
    source = f"https://raw.githubusercontent.com/wravery/webview2-rs/{sha}/crates/update-bindings/src/main.rs"
    text = downloads.get(source).decode()
    version = re.search(r'WEBVIEW2_VERSION\s*:\s*&str\s*=\s*"([0-9.]+)"', text)
    if not version:
        raise RuntimeError("cannot determine native WebView2 SDK version from pinned upstream source")
    version = version[1]
    url = f"https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/{version}/microsoft.web.webview2.{version}.nupkg"
    texts = []
    with zipfile.ZipFile(io.BytesIO(downloads.get(url))) as archive:
        for name in sorted(archive.namelist()):
            if LICENSE_NAME.match(Path(name).name) or "thirdpartynotices" in Path(name).name.lower():
                texts.append((f"{url} :: {name}", archive.read(name).decode("utf-8-sig").replace("\r\n", "\n").strip()))
    if not texts:
        raise RuntimeError("Microsoft WebView2 SDK package has no detected license text")
    return {"name": "Microsoft.Web.WebView2 (native loader)", "version": version,
            "license": "BSD-3-Clause (Microsoft SDK) / included third-party notices",
            "source": url, "texts": texts, "note": "The native loader is linked by webview2-com-sys. The separately installed WebView2 Runtime has its own terms."}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fetch-missing", action="store_true", help="fetch omitted license texts from pinned upstream commits")
    parser.add_argument("--target", default="x86_64-pc-windows-msvc", help="Cargo target triple, or all")
    parser.add_argument("--output", default="THIRD_PARTY_NOTICES.txt")
    args = parser.parse_args()
    downloads = Downloads(args.fetch_missing)
    packages = cargo_packages(args.target)
    records, unresolved, recovered = [], [], []
    mpl_text = None
    for package in packages:
        folder = Path(package["manifest_path"]).parent
        if package.get("license") == "MPL-2.0":
            for path in license_files(folder):
                text = read_text(path)
                if "Mozilla Public License" in text and "2.0" in text:
                    mpl_text = text
                    break
    for package in packages:
        folder = Path(package["manifest_path"]).parent
        source = f"https://crates.io/api/v1/crates/{package['name']}/{package['version']}/download"
        record = {"name": package["name"], "version": package["version"], "license": package.get("license") or "UNSPECIFIED",
                  "source": source, "texts": [(path.relative_to(folder).as_posix(), read_text(path)) for path in license_files(folder)]}
        if not record["texts"]:
            try:
                record["texts"] = upstream_licenses(package, folder, downloads)
                if not record["texts"] and package.get("license") == "MPL-2.0" and mpl_text:
                    record["texts"] = [("MPL-2.0 standard license text (same declared license; omitted from upstream package)", mpl_text)]
                if record["texts"]:
                    recovered.append(f"{package['name']} {package['version']}")
                    record["note"] = "The crate archive omits its standalone license. The matching pinned upstream license (or declared standard MPL text) is supplied below."
                    copyrights = source_copyrights(folder)
                    if copyrights:
                        record["texts"].append(("Copyright notices retained from published crate source headers", copyrights))
                else:
                    unresolved.append(f"{package['name']} {package['version']}: no license text in package or pinned upstream")
            except Exception as error:
                unresolved.append(f"{package['name']} {package['version']}: {type(error).__name__}: license recovery failed")
                print(f"License recovery failed for {package['name']}: {error}", file=sys.stderr)
        if package.get("license") == "MPL-2.0":
            record["note"] = record.get("note", "") + " MPL-2.0 source is available from the version-specific source archive above. Dropping does not modify these dependency sources."
        records.append(record)
        if package["name"] == "webview2-com-sys" and "windows" in args.target:
            try:
                records.append(webview_sdk(package, folder, downloads))
            except Exception as error:
                unresolved.append("Microsoft.Web.WebView2: native SDK license could not be recovered")
                print(f"Native SDK license recovery failed: {error}", file=sys.stderr)
    for package, folder in npm_packages():
        texts = [(path.relative_to(folder).as_posix(), read_text(path)) for path in license_files(folder)]
        if not texts:
            unresolved.append(f"npm {package['name']} {package['version']}: no license text in installed production package")
        records.append({"name": "npm " + package["name"], "version": package["version"],
                        "license": package.get("license", "UNSPECIFIED"),
                        "source": f"https://www.npmjs.com/package/{package['name']}/v/{package['version']}", "texts": texts})
    texts = {}
    lines = ["DROPPING — THIRD-PARTY LICENSES AND NOTICES", "",
             "Dropping's own source is MIT licensed; third-party components retain their respective licenses.",
             f"Scope: Cargo target {args.target}, including build-time dependencies, plus production npm packages.",
             "This inventory may include build-only components not linked into the final executable.",
             "Complete license texts are reproduced in the numbered text section and shared where identical.",
             "Source availability: version-specific upstream source URLs are listed for every package.",
             "For MPL-2.0 components, the corresponding source archives provide the covered source under MPL-2.0.",
             "Regenerate with: python tools/generate-notices.py --fetch-missing", "",
             f"Component records: {len(records)}", f"Recovered omitted crate license files: {len(recovered)}",
             f"Unresolved license texts: {len(unresolved)}", ""]
    if recovered:
        lines += ["Crates with omitted license files recovered from their upstream license:", *["  " + item for item in recovered], ""]
    if unresolved:
        lines += ["UNRESOLVED — DO NOT DISTRIBUTE THIS BINARY UNTIL REVIEWED:", *unresolved, ""]
    for index, record in enumerate(records, 1):
        lines += [f"COMPONENT {index}: {record['name']} {record['version']}", f"Declared license: {record['license']}", f"Source: {record['source']}"]
        if record.get("note"):
            lines.append(record["note"].strip())
        for origin, text in record["texts"]:
            digest = hashlib.sha256(text.encode()).hexdigest()
            if digest not in texts:
                texts[digest] = (len(texts) + 1, text)
            number = texts[digest][0]
            lines.append(f"License/copyright text {number}: {origin}")
        lines.append("")
    lines += ["FULL LICENSE AND COPYRIGHT TEXTS", ""]
    for number, text in texts.values():
        lines += [f"===== TEXT {number} =====", text, ""]
    result = "\n".join(lines)
    # Local build paths must never enter public release notices.
    for private_path in [str(ROOT), str(Path.home())]:
        if private_path in result or private_path.replace("\\", "/") in result:
            raise RuntimeError("a local workstation path appeared in the generated notice")
    output = (ROOT / args.output).resolve()
    if not output.is_relative_to(ROOT):
        raise RuntimeError("output must stay inside the repository")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(result, encoding="utf-8", newline="\n")
    print(f"Generated {output.name}: {len(records)} components, {len(texts)} distinct texts, {len(result.encode())} bytes, {len(unresolved)} unresolved")
    return 1 if unresolved else 0


if __name__ == "__main__":
    raise SystemExit(main())
