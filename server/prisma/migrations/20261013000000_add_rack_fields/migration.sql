-- AlterTable
ALTER TABLE "Company" ADD COLUMN "defaultDailyCap" INTEGER;

-- AlterTable
ALTER TABLE "Device" ADD COLUMN "rackSlot" INTEGER,
ADD COLUMN "switchPort" INTEGER,
ADD COLUMN "dailyCapOverride" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Device_rackSlot_key" ON "Device"("rackSlot");

-- CreateIndex
CREATE UNIQUE INDEX "Device_switchPort_key" ON "Device"("switchPort");
