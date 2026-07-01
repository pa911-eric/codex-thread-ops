function isoFromNow(referenceTime, deltaMs) {
  const now = referenceTime instanceof Date ? referenceTime : new Date(referenceTime);
  return new Date(now.getTime() + deltaMs).toISOString();
}

function getV2ThreadFixtures(referenceTime = new Date()) {
  return [
    {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Active running thread",
      workspace: "C:\\repos\\agentqueue\\workspace-active",
      workspaceLabel: "workspace-active",
      threadSource: "main",
      parentThreadId: null,
      tags: ["agentqueue", "running"],
      activityAt: isoFromNow(referenceTime, -1000 * 60),
      processUpdatedAt: isoFromNow(referenceTime, -30 * 1000),
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      title: "Stale running thread",
      workspace: "C:\\repos\\agentqueue\\workspace-stale",
      workspaceLabel: "workspace-stale",
      threadSource: "main",
      tags: ["agentqueue"],
      activityAt: isoFromNow(referenceTime, -55 * 60 * 1000),
      processUpdatedAt: isoFromNow(referenceTime, -35 * 60 * 1000),
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      title: "Recently completed thread",
      workspace: "C:\\repos\\agentqueue\\workspace-complete",
      workspaceLabel: "workspace-complete",
      threadSource: "subagent",
      parentThreadId: "11111111-1111-4111-8111-111111111111",
      completionAt: isoFromNow(referenceTime, -8 * 60 * 1000),
      activityAt: isoFromNow(referenceTime, -9 * 60 * 1000),
      riskSignal: false,
      indexUpdatedAt: isoFromNow(referenceTime, -7 * 60 * 1000),
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      title: "Unread or needs-attention thread",
      workspace: "C:\\repos\\agentqueue\\workspace-attention",
      workspaceLabel: "workspace-attention",
      threadSource: "main",
      tags: ["needs-review"],
      activityAt: isoFromNow(referenceTime, -60 * 1000),
      hasUnread: true,
      hasAttentionTag: true,
      riskSignal: true,
    },
    {
      id: "55555555-5555-4555-8555-555555555555",
      title: "Quiet done thread",
      workspace: "C:\\repos\\agentqueue\\workspace-quiet",
      workspaceLabel: "workspace-quiet",
      threadSource: "main",
      completionAt: isoFromNow(referenceTime, -6 * 60 * 60 * 1000),
      activityAt: isoFromNow(referenceTime, -7 * 60 * 60 * 1000),
      riskSignal: false,
    },
    {
      id: "66666666-6666-4666-8666-666666666666",
      title: "Missing or incomplete local state",
      workspace: null,
      workspaceLabel: null,
      threadSource: "main",
      missingLocalState: true,
      tags: [],
    },
  ];
}

module.exports = { getV2ThreadFixtures };
