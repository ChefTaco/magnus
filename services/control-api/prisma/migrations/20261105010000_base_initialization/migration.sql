CREATE TABLE "product_initializations" (
  "id" TEXT NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_initializations_pkey" PRIMARY KEY ("id")
);
