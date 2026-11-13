import { supabase } from './supabaseClient';
import type { GoogleSale } from './googleSales';
/** Explicit pagination avoids Supabase's default 1,000-row cap silently dropping outcomes. */
export async function loadGoogleSales(clientId: string): Promise<{data: GoogleSale[]; error: {message: string} | null}> {
  const rows: GoogleSale[] = [];
  for (let offset=0; offset<100000; offset+=500) {
    const {data,error}=await supabase.from('google_sales_appointments').select('*').eq('client_id',clientId).order('id').range(offset,offset+499);
    if (error) return {data:[],error};
    rows.push(...(data || []) as GoogleSale[]);
    if (!data || data.length<500) return {data:rows,error:null};
  }
  return {data:[],error:{message:'Il registro supera il limite di lettura. Nessun totale parziale viene mostrato.'}};
}
