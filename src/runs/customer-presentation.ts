export type CustomerRunFailure = {
  title: string;
  message: string;
};

export function customerRunFailure(errorCode: string | null, stage: string): CustomerRunFailure {
  if (stage === "VERIFYING" || errorCode?.startsWith("VERIFICATION_")) {
    return {
      title: "Verification stopped",
      message:
        "Patchrail could not verify the proposed repository changes, so no Draft PR was created. Retry as a new run after reviewing the repository checks.",
    };
  }
  if (stage === "CREATING_PR" || errorCode?.startsWith("GITHUB_")) {
    return {
      title: "Draft PR delivery stopped",
      message:
        "Patchrail could not deliver the verified update as a Draft PR. Confirm repository access, then retry as a new run.",
    };
  }
  if (stage === "READING_REPOSITORY" || errorCode?.startsWith("REPOSITORY_")) {
    return {
      title: "Repository analysis stopped",
      message:
        "Patchrail could not finish reading the pinned repository commit. No repository changes or Draft PR were created.",
    };
  }
  return {
    title: "Analysis stopped",
    message:
      "Patchrail could not complete the repository analysis. No unverified repository changes or Draft PR were created. Retry as a new run.",
  };
}

export function customerEventMessage(input: {
  stage: string;
  kind: string;
  message: string;
  failure: CustomerRunFailure | null;
}): string {
  if (input.kind === "ERROR") {
    return input.failure?.message ?? "Patchrail stopped before this step could complete.";
  }
  if (
    /(?:model calls?|model tokens?|input tokens?|output tokens?|cached tokens?|AI (?:cost|spend|budget)|cost (?:authorization|reservation)|maximum run cost|cost[^.]{0,40}reserv|reserv(?:e|ed|ation)[^.]{0,40}cost|\bgpt-[\w.-]+)/i.test(
      input.message,
    )
  ) {
    if (input.stage === "QUEUED") return "Repository update queued";
    if (["FINDING_APIS", "RESEARCHING_APIS"].includes(input.stage)) {
      return "Repository analysis is in progress";
    }
    if (["PLANNING_CHANGES", "UPDATING_CODE", "REPAIRING"].includes(input.stage)) {
      return "Patchrail is preparing repository changes";
    }
    return "Patchrail completed this step";
  }
  return input.message;
}
