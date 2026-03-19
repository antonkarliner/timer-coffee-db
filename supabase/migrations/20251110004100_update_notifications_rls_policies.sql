-- Update RLS policies for notifications table to match launch popup pattern
-- Allow authenticated users to insert notifications (like launch_popup)
-- Keep service role policy for system operations

-- Drop existing policies (including the new ones we're about to create)
DROP POLICY IF EXISTS "Service role can manage notifications" ON public.notifications;
DROP POLICY IF EXISTS "Users can view notifications" ON public.notifications;
DROP POLICY IF EXISTS "Enable read access for authenticated users" ON public.notifications;
DROP POLICY IF EXISTS "Allow insert for authenticated users" ON public.notifications;

-- Create new policies matching launch_popup pattern
CREATE POLICY "Enable read access for authenticated users" ON public.notifications
    FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Allow insert for authenticated users" ON public.notifications
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- Keep service role policy for system operations (cron jobs, etc.)
CREATE POLICY "Service role can manage notifications" ON public.notifications
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');