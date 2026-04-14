import './globals.css';

export const metadata = {
  title: 'Budgentin',
  description: 'Financial tracker app',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
