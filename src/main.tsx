import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { UpdateNotice } from "./components/UpdateNotice";
import { installErrorLog } from "./lib/errorLog";
import { AuthGate } from "./state/auth";
import { AccountsReportProvider } from "./state/accountsReport";
import { DataProvider } from "./state/data";
import { IncomeStatusProvider } from "./state/incomeStatus";
import { AttachmentsProvider } from "./state/attachments";
import { PnlProvider } from "./state/pnl";
import { RatesProvider } from "./state/rates";
import { SettingsProvider } from "./state/settings";
import { SyncProvider } from "./state/sync";
import { UIProvider } from "./state/ui";
import { UpdateProvider } from "./state/updates";
import "@fontsource-variable/onest";
import "./index.css";

// Yakalanmamış hatalar "Hata bildir" raporu için yerelde kaydedilir
installErrorLog();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      {/* Güncelleme uyarısı giriş ekranında da görünür: oturum kapısının dışında */}
      <UpdateProvider>
        <AuthGate>
          <DataProvider>
            <RatesProvider>
              <PnlProvider>
                <AccountsReportProvider>
                  <IncomeStatusProvider>
                    <AttachmentsProvider>
                      <SettingsProvider>
                        <UIProvider>
                          <SyncProvider>
                            <App />
                          </SyncProvider>
                        </UIProvider>
                      </SettingsProvider>
                    </AttachmentsProvider>
                  </IncomeStatusProvider>
                </AccountsReportProvider>
              </PnlProvider>
            </RatesProvider>
          </DataProvider>
        </AuthGate>
        <UpdateNotice />
      </UpdateProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
