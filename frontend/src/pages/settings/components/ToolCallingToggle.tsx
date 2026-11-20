import { Switch, Label, Header } from "@/components";
import { useApp } from "@/contexts";

interface ToolCallingToggleProps {
  className?: string;
}

export const ToolCallingToggle = ({ className }: ToolCallingToggleProps) => {
  const { customizable, toggleToolCalling, pielySelection } = useApp();

  const isEnabled = customizable?.toolCalling?.isEnabled ?? false;

  const handleSwitchChange = async (checked: boolean) => {
    await toggleToolCalling(checked);
  };

  return (
    <div id="tool-calling" className={`space-y-2 ${className}`}>
      <Header
        title="Computer Use (Tool Calling)"
        description="Let the assistant search your files by name and by content, look inside them, and suggest opening files or apps. Requires a pi provider."
        isMainTitle
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div>
            <Label className="text-sm font-medium">
              {isEnabled ? "Disable Tool Calling" : "Enable Tool Calling"}
            </Label>
            <p className="text-xs text-muted-foreground mt-1">
              {isEnabled
                ? "The assistant can search file names and file contents, and suggest opening files and apps. Reading a file or opening something always asks for your confirmation."
                : "The assistant answers from the model only, with no access to your machine"}
            </p>
            {isEnabled && !pielySelection && (
              <p className="text-xs text-muted-foreground mt-1">
                Connect a pi provider in the Dashboard to use tool calling.
              </p>
            )}
          </div>
        </div>
        <Switch
          checked={isEnabled}
          onCheckedChange={handleSwitchChange}
          aria-label="Toggle computer use tool calling"
        />
      </div>
    </div>
  );
};
