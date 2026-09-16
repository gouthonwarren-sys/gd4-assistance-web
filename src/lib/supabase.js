import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://loovbsraccdgofmakyqq.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxvb3Zic3JhY2NkZ29mbWFreXFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1MTEyMTQsImV4cCI6MjEwMTA4NzIxNH0.1rXT1n0RMNKQZK_G7lGDqR0QYeMQHjCxiTsKSXzaYC8';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);