/**
 * Providers, routing and pages, in their own module so the capture-overlay
 * windows only load the selection UI.
 */
import { AppProvider, ThemeProvider } from "./contexts";
import AppRoutes from "./routes";

const Dashboard = () => (
  <ThemeProvider>
    <AppProvider>
      <AppRoutes />
    </AppProvider>
  </ThemeProvider>
);

export default Dashboard;
