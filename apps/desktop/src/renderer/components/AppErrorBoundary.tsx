import React from "react";
import { AlertTriangle, Home, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStore } from "@/stores/main-store";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AppErrorBoundaryProps {
  /** Content to render when no error has occurred */
  children: React.ReactNode;
}

export interface AppErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * AppErrorBoundary — catches rendering errors in the active page region
 * and displays a concise recovery UI.
 *
 * Features:
 *  - Catches errors via getDerivedStateFromError
 *  - "Try again" clears boundary state and re-renders children
 *  - "Go home" navigates to the home page via Zustand store
 *
 * Designed to wrap the active page region (renderPage output) without
 * affecting root-level dialogs or viewer lifecycle behavior.
 *
 * @example
 *   <AppErrorBoundary>
 *     <main>{renderPage()}</main>
 *   </AppErrorBoundary>
 */
export class AppErrorBoundary extends React.Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  constructor(props: AppErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[AppErrorBoundary] Caught error:", error, info);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  handleGoHome = (): void => {
    this.setState({ hasError: false, error: null });
    useStore.getState().navigate("home");
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div role="alert" className="flex flex-col items-center justify-center h-full p-8 text-center">
          {/* Error icon */}
          <div className="flex items-center justify-center h-12 w-12 rounded-dialog bg-danger/10 mb-4">
            <AlertTriangle className="h-6 w-6 text-danger" />
          </div>

          {/* Error message */}
          <h2 className="text-lg font-semibold text-text-primary mb-1">
            Something went wrong
          </h2>
          <p className="text-sm text-text-secondary max-w-md mb-6">
            {this.state.error?.message ?? "An unexpected error occurred."}
          </p>

          {/* Recovery actions */}
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={this.handleGoHome}>
              <Home className="h-4 w-4 mr-1" />
              Go home
            </Button>
            <Button onClick={this.handleRetry}>
              <RefreshCw className="h-4 w-4 mr-1" />
              Try again
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
