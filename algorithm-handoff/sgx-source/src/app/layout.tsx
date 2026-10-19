import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI 回忆录助手 - 记录您的人生故事',
  description: '通过温和的对话，帮助您记录和书写人生故事，生成珍贵的回忆录',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="bg-gray-50 min-h-screen">
        {children}
      </body>
    </html>
  );
}
