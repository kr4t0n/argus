-- CreateTable
CREATE TABLE "LiveActivityToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveActivityToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LiveActivityToken_token_key" ON "LiveActivityToken"("token");

-- CreateIndex
CREATE INDEX "LiveActivityToken_sessionId_idx" ON "LiveActivityToken"("sessionId");

-- AddForeignKey
ALTER TABLE "LiveActivityToken" ADD CONSTRAINT "LiveActivityToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
