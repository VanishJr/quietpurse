import { Shell } from './Shell';
import { ThemeProvider } from './theme';

export function App() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}
