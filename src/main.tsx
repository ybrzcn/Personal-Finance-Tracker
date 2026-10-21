import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installErrorLog } from "./lib/errorLog";
import { AuthGate } from "./state/auth";
import { AccountsReportProvider } from "./state/accountsReport";
import { DataProvider } from "./state/data";
import { IncomeStatusProvider } from "./state/incomeStatus";
import { PnlProvider } from "./state/pnl";
import { RatesProvider } from "./state/rates";
import { SettingsProvider } from "./state/settings";
import { UIProvider } from "./state/ui";
import "@fontsource-variable/onest";
import "./index.css";

// Yakalanmamış hatalar "Hata bildir" raporu için yerelde kaydedilir
installErrorLog();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthGate>
        <DataProvider>
          <RatesProvider>
            <PnlProvider>
              <AccountsReportProvider>
                <IncomeStatusProvider>
                  <SettingsProvider>
                    <UIProvider>
                      <App />
                    </UIProvider>
                  </SettingsProvider>
                </IncomeStatusProvider>
              </AccountsReportProvider>
            </PnlProvider>
          </RatesProvider>
        </DataProvider>
      </AuthGate>
    </ErrorBoundary>
  </React.StrictMode>,
);
