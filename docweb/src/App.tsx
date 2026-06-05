import { Routes, Route } from "react-router-dom";
import { Layout } from "antd";

import AppHeader from "./components/AppHeader";
import Footer from "./components/Footer";
import FloatingActions from "./components/FloatingActions";
import Landing from "./pages/Landing";
import DocsLayout from "./pages/DocsLayout";
import DocsHome from "./pages/DocsHome";
import DocArticle from "./pages/DocArticle";
import IdeasPage from "./pages/IdeasPage";
import IdeaDetailPage from "./pages/IdeaDetailPage";
import SubmitIdeaPage from "./pages/SubmitIdeaPage";
import Download from "./pages/Download";
import Plugins from "./pages/Plugins";
import NotFound from "./pages/NotFound";

const { Content } = Layout;

export default function App() {
  return (
    <Layout className="app-shell">
      <AppHeader />
      <Content className="app-content">
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/download" element={<Download />} />
          <Route path="/plugins" element={<Plugins />} />
          <Route path="/ideas" element={<IdeasPage />} />
          <Route path="/ideas/new" element={<SubmitIdeaPage />} />
          <Route path="/ideas/:id" element={<IdeaDetailPage />} />
          <Route path="/docs" element={<DocsLayout />}>
            <Route index element={<DocsHome />} />
            <Route path=":slug" element={<DocArticle />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Content>
      <Footer />
      <FloatingActions />
    </Layout>
  );
}
