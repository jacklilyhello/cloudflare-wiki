import type { MoveLinkImpact } from "../../shared/relative-links";

export function MoveLinks({
  links,
  zh,
}: {
  links: MoveLinkImpact[];
  zh: boolean;
}) {
  return (
    <div className="move-links">
      <p>
        {zh
          ? "相对链接保留原语义；原文和历史版本不变。"
          : "Relative links retain their meaning; source and history stay unchanged."}
      </p>
      {links.length === 0 ? (
        <p>{zh ? "没有受影响的相对链接。" : "No affected relative links."}</p>
      ) : (
        <ul>
          {Array.from(
            new Map(links.map((link) => [JSON.stringify(link), link])).values(),
          ).map((link) => (
            <li
              key={`${link.revision}:${link.source}:${link.before}:${link.after}`}
            >
              <strong>
                {link.revision === "draft"
                  ? zh
                    ? "草稿"
                    : "Draft"
                  : zh
                    ? "已发布"
                    : "Published"}
              </strong>{" "}
              <code>{link.source}</code>
              <div>
                {zh ? "原目标：" : "Before: "}
                <code>{link.before}</code>
              </div>
              <div>
                {zh ? "移动后目标：" : "After: "}
                <code>{link.after}</code>
              </div>
              {link.target === "missing" && (
                <span>
                  {zh
                    ? "目标目前不存在；保留原地址。"
                    : "Target currently missing; original address preserved."}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
