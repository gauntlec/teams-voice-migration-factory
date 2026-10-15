import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';

interface State {
  error: Error | null;
}

/**
 * Catches a rendering error in one page so it shows a message instead of blanking the whole app (the menu and customer switcher stay).
 * Give it a `key` that changes with the page, so moving to another page tries again.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('Page error:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <MessageBar intent="error" layout="multiline">
        <MessageBarBody>
          <MessageBarTitle>Something went wrong showing this page</MessageBarTitle>
          The rest of Voxshift still works: use the menu to go somewhere else, or reload. If it keeps happening, tell us what you were doing ({this.state.error.message}).
        </MessageBarBody>
        <MessageBarActions>
          <Button size="small" onClick={() => window.location.reload()}>
            Reload
          </Button>
          <Button size="small" appearance="subtle" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </MessageBarActions>
      </MessageBar>
    );
  }
}
