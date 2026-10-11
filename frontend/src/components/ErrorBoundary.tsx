import React from "react";

interface ErrorBoundaryProps {
  fallbackRender: (props: { error: Error | null; reset: () => void }) => React.ReactNode;
  resetKeys?: unknown[];
  onReset?: () => void;
  children: React.ReactNode;
}

/** Minimal error boundary (replaces react-error-boundary). */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (this.state.error && prevProps.resetKeys !== this.props.resetKeys) {
      this.setState({ error: null });
    }
  }

  reset = () => {
    this.props.onReset?.();
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return this.props.fallbackRender({ error: this.state.error, reset: this.reset });
    }
    return this.props.children;
  }
}
