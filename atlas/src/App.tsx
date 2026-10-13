import { BrowserRouter, Route, Routes } from "react-router"

import { Layout, NotFound } from "./components/layout.tsx"
import { AgentsPage } from "./pages/agents.tsx"
import { ApiPage } from "./pages/api.tsx"
import { AreaPage, AreasPage } from "./pages/areas.tsx"
import { DataPage } from "./pages/data.tsx"
import { FlowPage, FlowsPage } from "./pages/flows.tsx"
import { MapPage } from "./pages/map.tsx"
import { RunnerPage } from "./pages/runner.tsx"
import { UiPage } from "./pages/ui.tsx"

export const App = () => (
  <BrowserRouter>
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<MapPage />} />
        <Route path="areas" element={<AreasPage />} />
        <Route path="areas/*" element={<AreaPage />} />
        <Route path="ui" element={<UiPage />} />
        <Route path="runner" element={<RunnerPage />} />
        <Route path="api" element={<ApiPage />} />
        <Route path="data" element={<DataPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="flows" element={<FlowsPage />} />
        <Route path="flows/:id" element={<FlowPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  </BrowserRouter>
)
