-- CreateTable
CREATE TABLE "Terminal" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'opening',
    "shell" TEXT NOT NULL,
    "cwd" TEXT,
    "cols" INTEGER NOT NULL DEFAULT 120,
    "rows" INTEGER NOT NULL DEFAULT 32,
    "exitCode" INTEGER,
    "closeReason" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Terminal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Terminal_agentId_openedAt_idx" ON "Terminal"("agentId", "openedAt");

-- CreateIndex
CREATE INDEX "Terminal_userId_openedAt_idx" ON "Terminal"("userId", "openedAt");

-- CreateIndex
CREATE INDEX "Terminal_status_idx" ON "Terminal"("status");

-- AddForeignKey
ALTER TABLE "Terminal" ADD CONSTRAINT "Terminal_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
