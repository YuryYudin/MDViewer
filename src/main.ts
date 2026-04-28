import { invoke } from '@tauri-apps/api/core';

interface BuildInfo {
  version: string;
  commit_hash: string;
}

async function main() {
  const info = await invoke<BuildInfo>('app_info');
  const root = document.getElementById('app')!;
  root.textContent = `MDViewer ${info.version} (${info.commit_hash})`;
}

main().catch((err) => {
  document.body.append(`Bootstrap error: ${err}`);
});
