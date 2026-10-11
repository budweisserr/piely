import { Badge, Input, Card, Empty } from "@/components";
import { useHistory } from "@/hooks";
import { PageLayout } from "@/layouts";
import { MessageCircleIcon, Search } from "lucide-react";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "@/contexts";
import { formatDateKey, formatShortDate, formatTime } from "@/lib/utils";

const Dashboard = () => {
  const conversations = useHistory();
  const navigate = useNavigate();
  const { selectedAIProvider, pielySelection } = useApp();

  // No provider connected: send the user to the login page
  useEffect(() => {
    if (!pielySelection && !selectedAIProvider.provider) {
      navigate("/dashboard");
    }
  }, [pielySelection, selectedAIProvider.provider, navigate]);
  // Group conversations by date
  const groupedConversations = conversations.conversations.reduce(
    (acc, doc) => {
      const dateKey = formatDateKey(doc.updatedAt);
      if (!acc[dateKey]) {
        acc[dateKey] = [];
      }
      acc[dateKey].push(doc);
      return acc;
    },
    {} as Record<string, typeof conversations.conversations>
  );

  // Sort dates in descending order (most recent first)
  const sortedDates = Object.keys(groupedConversations).sort(
    (a, b) => new Date(b).getTime() - new Date(a).getTime()
  );

  return (
    <PageLayout
      title="All conversations"
      description="View all your conversations"
    >
      <>
        {conversations.conversations.length === 0 ? (
          <Empty
            isLoading={conversations.isLoading}
            icon={MessageCircleIcon}
            title="No conversations found"
            description="Start a new conversation to get started"
          />
        ) : (
          <div className="flex flex-col gap-6 pb-8">
            <div className="relative mb-4 w-full max-w-sm">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search conversations..."
                className="pl-9 focus-visible:ring-0 focus-visible:ring-offset-0"
                value={conversations.search}
                onChange={(e) => conversations.setSearch(e.target.value)}
              />
            </div>
            {sortedDates
              .filter((dateKey) =>
                conversations?.search?.length === 0
                  ? true
                  : groupedConversations?.[dateKey]?.some((doc) =>
                      doc?.title
                        .toLowerCase()
                        .includes(conversations?.search?.toLowerCase() || "")
                    )
              )
              .map((dateKey) => (
                <div key={dateKey} className="flex flex-col gap-3">
                  <p className="text-xs text-muted-foreground select-none font-medium">
                    {formatShortDate(new Date(dateKey).getTime())}
                  </p>
                  <div className="grid grid-cols-1 gap-3">
                    {groupedConversations[dateKey].map((doc) => (
                      <Card
                        key={doc.id}
                        className="shadow-none select-none p-4 gap-0 group relative transition-all !bg-black/5 dark:!bg-white/5 hover:!border-primary/50 cursor-pointer"
                        onClick={() => navigate(`/chats/view/${doc.id}`)}
                      >
                        <div className="flex items-center justify-between">
                          <p className="line-clamp-1 text-sm mr-8">
                            {doc.title}
                          </p>
                          <div className="flex items-center gap-1">
                            <Badge variant="outline" className="text-xs">
                              {doc.messageCount} messages
                            </Badge>
                            <Badge variant="outline" className="text-xs">
                              {formatTime(doc.updatedAt)}
                            </Badge>
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        )}
      </>
    </PageLayout>
  );
};

export default Dashboard;
