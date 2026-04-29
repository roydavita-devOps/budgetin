import './globals.css';

export const metadata = {
  title: 'Budgetin',
  description: 'Financial tracker app',
};

const themeInitScript = `
(() => {
  try {
    const storageKey = 'budgetin_theme';
    const savedTheme = localStorage.getItem(storageKey);
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    const theme = savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : systemTheme;
    document.documentElement.dataset.theme = theme;
  } catch (error) {
    document.documentElement.dataset.theme = 'light';
  }
})();
`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
