/**
 * 「出力を見る前に期待を固定する」を構造で守る。
 * 評価は docs/preregistration.md がコミット済みで、未コミットの変更が無いときだけ回せる。
 * 返したコミット ID を評価の出力に刻み、どの事前登録で回したかを後から辿れるようにする。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const PREREG_PATH = "docs/preregistration.md";

export async function committedPreregistration(cwd = process.cwd()): Promise<string> {
  const git = async (...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
  try {
    await git("rev-parse", "--is-inside-work-tree");
  } catch {
    throw new Error(`事前登録を確かめられない。git リポジトリの直下で実行する（${PREREG_PATH}）`);
  }
  const dirty = await git("status", "--porcelain", "--", PREREG_PATH);
  // コミットが 1 つも無いリポジトリでは git log が失敗するので、未コミットと同じに扱う
  const sha = await git("log", "-1", "--format=%H", "--", PREREG_PATH).catch(() => "");
  if (!sha) throw new Error(`事前登録がコミットされていない。先に ${PREREG_PATH} をコミットする`);
  if (dirty) throw new Error(`事前登録に未コミットの変更がある。先に ${PREREG_PATH} をコミットする`);
  return sha;
}
