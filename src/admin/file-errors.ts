import { ApiError } from "./api";

export function authentication(error: unknown) {
  return error instanceof ApiError && [401, 403].includes(error.status);
}
export function failureText(error: unknown, zh: boolean) {
  if (authentication(error))
    return zh
      ? "会话需要重新验证。你的输入仍保留在此标签页。"
      : "Verify your session again. Your input remains in this tab.";
  if (error instanceof ApiError) {
    if (error.status === 412)
      return zh
        ? "文件已发生变化。读取最新信息并比较后，再确认操作。"
        : "The file changed. Load and compare its latest information before confirming.";
    if (error.status === 409)
      return zh
        ? "当前状态或目标不允许此操作。请检查重名、文件夹层级、非空目录及上传状态。"
        : "The current state or destination does not allow this action. Check name collisions, folder depth, non-empty folders and upload state.";
    if (error.status === 404)
      return zh
        ? "此文件已不可用。请重新读取文件列表。"
        : "This file is no longer available. Reload the file list.";
    if (error.status === 400)
      return zh
        ? "请检查名称、替代文本和所选目录。"
        : "Check the name, alternative text and selected folder.";
  }
  return zh
    ? "暂时无法确认操作结果。请先比较最新状态，不要直接重复提交。"
    : "The result could not be confirmed. Compare the latest state before submitting again.";
}
