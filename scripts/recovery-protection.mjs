export async function verifyRecoveryEnvironment(token, fetchRequest = fetch) {
  const base =
    "https://api.github.com/repos/jacklilyhello/cloudflare-wiki/environments/administrator-recovery";
  async function read(url) {
    try {
      const response = await fetchRequest(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch {
      throw new Error("Unable to verify the protected recovery environment.");
    }
  }
  const env = await read(base);
  const branches = await read(
    `${base}/deployment-branch-policies?per_page=100`,
  );
  const review = env.protection_rules?.find(
    (rule) => rule.type === "required_reviewers",
  );
  if (
    env.name !== "administrator-recovery" ||
    env.deployment_branch_policy?.custom_branch_policies !== true ||
    env.deployment_branch_policy?.protected_branches !== false ||
    review?.reviewers?.length !== 1 ||
    review.reviewers[0].type !== "User" ||
    review.reviewers[0].reviewer?.login !== "jacklilyhello" ||
    branches.total_count !== 1 ||
    branches.branch_policies?.length !== 1 ||
    branches.branch_policies[0].name !== "main" ||
    branches.branch_policies[0].type !== "branch"
  )
    throw new Error(
      "Recovery requires the sole repository owner's review and a main-only branch policy.",
    );
}
