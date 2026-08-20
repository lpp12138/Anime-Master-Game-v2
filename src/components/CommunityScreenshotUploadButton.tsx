"use client";

import { Button } from "@/components/Button";
import { getLocalSession, saveLocalSession } from "@/lib/localSession";
import { useRouter } from "@/lib/router";

export function CommunityScreenshotUploadButton({
  nickname = "",
  className = "",
}: {
  nickname?: string;
  className?: string;
}) {
  const router = useRouter();

  return (
    <Button
      className={className}
      type="button"
      variant="secondary"
      onClick={() => {
        const session = getLocalSession();
        const normalizedNickname = nickname.trim();
        if (normalizedNickname) {
          saveLocalSession({ playerId: session.playerId, nickname: normalizedNickname });
        }
        router.push("/community-upload", { communityUploadEntry: true });
      }}
    >
      密钥上传截图
    </Button>
  );
}
