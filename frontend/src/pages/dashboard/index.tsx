import { PielyProviderLogin } from "@/components";
import { PageLayout } from "@/layouts";

const Dashboard = () => {
  return (
    <PageLayout
      title="Dashboard"
      description="Log in to an AI provider with pi and pick a model to power your responses."
    >
      {/* Piely (pi login) Setup */}
      <PielyProviderLogin />
    </PageLayout>
  );
};

export default Dashboard;
