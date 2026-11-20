import {
  AlertTriangleIcon,
  AppWindowIcon,
  CheckIcon,
  FilePlusIcon,
  FileSearchIcon,
  FileTextIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  Loader2,
  SearchIcon,
} from "lucide-react";
import { Button } from "@/components";
import { AgentActivity, PendingToolAction } from "@/lib";

const TOOL_LABELS: Record<string, string> = {
  find_files: "Searching files by name",
  search_files_content: "Searching inside files",
  list_directory: "Listing folder",
  read_file: "Previewing file",
  write_file: "Writing file",
  list_apps: "Listing applications",
  open_file: "Opening file",
  open_app: "Opening application",
};

const TOOL_ICONS: Record<string, React.ElementType> = {
  find_files: SearchIcon,
  search_files_content: FileSearchIcon,
  list_directory: FolderTreeIcon,
  read_file: FileTextIcon,
  write_file: FilePlusIcon,
  list_apps: AppWindowIcon,
  open_file: FolderOpenIcon,
  open_app: FolderOpenIcon,
};

/**
 * What the confirm button does, per tool. `read_file` sends the file's contents
 * to the AI provider, so calling that button "Open" would describe the wrong
 * action in the one dialog whose job is informed consent.
 */
const CONFIRM_LABELS: Record<string, string> = {
  read_file: "Read",
  write_file: "Create",
  open_file: "Open",
  open_app: "Launch",
};

/** "Create" reads wrong when the file is already there. */
const confirmLabel = (action: PendingToolAction): string =>
  action.name === "write_file" && action.args.overwrite === true
    ? "Overwrite"
    : CONFIRM_LABELS[action.name] ?? "Allow";

/** The first lines of a file the model wants to write, for the consent row. */
const contentPreview = (action: PendingToolAction): string | null =>
  action.name === "write_file" && typeof action.args.content === "string"
    ? action.args.content.slice(0, 400)
    : null;

/** Short label shown while a tool call is still running. */
const describeRunning = (activity: AgentActivity): string => {
  const label = TOOL_LABELS[activity.name] ?? activity.name;
  const target = activity.args.path ?? activity.args.query ?? activity.args.name;
  return target ? `${label}: ${String(target)}` : label;
};

interface ToolActivityProps {
  activities: AgentActivity[];
  pendingActions: PendingToolAction[];
  onAction: (action: PendingToolAction, approved: boolean) => void;
}

/**
 * Live view of the computer-use tool calls in the current turn, plus the
 * confirm/dismiss buttons for actions that touch the machine.
 */
export const ToolActivity = ({
  activities,
  pendingActions,
  onAction,
}: ToolActivityProps) => {
  if (activities.length === 0 && pendingActions.length === 0) {
    return null;
  }

  const actionFor = (activity: AgentActivity) =>
    pendingActions.find((action) => action.id === activity.id);

  return (
    <div className="mb-4 space-y-2 select-none">
      {activities.map((activity) => {
        const action = actionFor(activity);
        const Icon = TOOL_ICONS[activity.name] ?? SearchIcon;
        const preview = action ? contentPreview(action) : null;
        return (
          <div
            key={activity.id}
            className="rounded-md border border-input/50 bg-muted/30 px-3 py-2 text-xs"
          >
            <div className="flex items-center gap-2">
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">
                {activity.status === "running"
                  ? describeRunning(activity)
                  : activity.summary ?? activity.name}
              </span>
              {activity.status === "running" && (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              )}
              {activity.status === "done" && (
                <CheckIcon className="size-3.5 text-green-600" />
              )}
              {activity.status === "error" && (
                <AlertTriangleIcon className="size-3.5 text-destructive" />
              )}
              {action && (
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => onAction(action, true)}
                  >
                    {confirmLabel(action)}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => onAction(action, false)}
                  >
                    Dismiss
                  </Button>
                </div>
              )}
            </div>
            {preview && (
              <pre className="mt-2 max-h-24 overflow-hidden whitespace-pre-wrap break-all rounded border border-input/40 bg-background/60 p-2 text-[10px] leading-snug text-muted-foreground">
                {preview}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
};
