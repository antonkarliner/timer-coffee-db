import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.42.5'

// Supabase client setup
const supabaseUrl = Deno.env.get('SUPABASE_URL')
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const ADMIN_EMAIL = Deno.env.get('ADMIN_EMAIL')

if (!supabaseUrl || !supabaseServiceRoleKey || !RESEND_API_KEY || !ADMIN_EMAIL) {
  throw new Error('Required environment variables are not set')
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)

// Function to sanitize and transliterate filename
function sanitizeFilename(name: string): string {
  const transliterationMap: { [key: string]: string } = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo', 'ж': 'zh',
    'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o',
    'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'ts',
    'ч': 'ch', 'ш': 'sh', 'щ': 'sch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya'
  }
  
  return name.toLowerCase()
    .split('')
    .map((char: string) => transliterationMap[char] || char)
    .join('')
    .replace(/[^\w\s-]/g, '')
    .replace(/[-\s]+/g, '_')
}

// Function to download image
async function downloadImage(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
  return await response.arrayBuffer()
}

// Function to determine file extension
function getFileExtension(url: string, contentType: string | null): string {
  const extensionMap: { [key: string]: string } = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/svg+xml': '.svg'
  }
  
  // Try to get extension from content-type
  if (contentType && extensionMap[contentType]) {
    return extensionMap[contentType]
  }
  
  // Fallback to URL parsing
  const urlParts = url.split('.')
  return urlParts.length > 1 ? `.${urlParts.pop()?.toLowerCase()}` : '.jpg'
}

// Function to send error email
async function sendErrorEmail(subject: string, body: string): Promise<void> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'logo_errors@timer.coffee',
        to: ADMIN_EMAIL,
        subject: subject,
        html: body,
      }),
    })

    if (!res.ok) {
      console.error('Failed to send error email:', await res.text())
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error('Error sending email:', error.message)
    } else {
      console.error('Error sending email:', error)
    }
  }
}

// Main function to process a new coffee roaster
async function processCoffeeRoaster(roasterId: string, roasterName: string, logoUrl: string): Promise<string | null> {
  try {
    if (!logoUrl) {
      console.log(`No logo URL for roaster ${roasterName}. Skipping processing.`)
      return null
    }

    const imageResponse = await fetch(logoUrl)
    const contentType = imageResponse.headers.get('content-type')
    const imageBuffer = await downloadImage(logoUrl)
    
    const fileExtension = getFileExtension(logoUrl, contentType)
    const sanitizedName = sanitizeFilename(roasterName)
    const filename = `${sanitizedName}${fileExtension}`

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from('roaster_logo_mirrors')
      .upload(filename, imageBuffer, {
        contentType: contentType === 'image/svg+xml' ? 'image/svg+xml' : (contentType || 'image/jpeg')
      })

    if (uploadError) throw uploadError

    // Get public URL
    const { data: urlData } = await supabase.storage
      .from('roaster_logo_mirrors')
      .getPublicUrl(filename)

    if (!urlData || !urlData.publicUrl) throw new Error('Failed to get public URL')

    // Update the coffee_roasters table with the new URL
    const { error: updateError } = await supabase
      .from('coffee_roasters')
      .update({ roaster_logo_mirror_url: urlData.publicUrl })
      .eq('id', roasterId)

    if (updateError) throw updateError

    console.log(`Successfully processed logo for ${roasterName}`)
    return urlData.publicUrl
  } catch (error) {
    let errorMessage = 'Unknown error'
    if (error instanceof Error) {
      errorMessage = error.message
      console.error(`Error processing roaster ${roasterName}: ${error.message}`)
    } else {
      console.error(`Error processing roaster ${roasterName}:`, error)
    }
    
    // Send error email
    await sendErrorEmail(
      `Error processing roaster: ${roasterName}`,
      `An error occurred while processing the logo for roaster ${roasterName}:<br><br>
      Error message: ${errorMessage}<br>
      Roaster ID: ${roasterId}<br>
      Logo URL: ${logoUrl}`
    )

    return null
  }
}

// Supabase Edge Function handler
Deno.serve(async (req) => {
  const { record, type } = await req.json()

  if (type === 'INSERT' && record && record.id && record.roaster_name && record.roaster_logo_url) {
    const result = await processCoffeeRoaster(record.id, record.roaster_name, record.roaster_logo_url)
    
    if (result) {
      return new Response(JSON.stringify({ success: true, url: result }), {
        headers: { 'Content-Type': 'application/json' }
      })
    } else {
      return new Response(JSON.stringify({ success: false, error: 'Processing failed' }), {
        headers: { 'Content-Type': 'application/json' }
      })
    }
  }

  return new Response(JSON.stringify({ success: false, error: 'Invalid request' }), {
    headers: { 'Content-Type': 'application/json' }
  })
})
