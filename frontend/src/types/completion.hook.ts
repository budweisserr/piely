import type { useCompletion } from "@/hooks/chat/useCompletion";

/** What `useCompletion` returns, derived so it cannot drift. */
export type UseCompletionReturn = ReturnType<typeof useCompletion>;
